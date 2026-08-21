import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface ModelsResult {
  success: boolean;
  models: string[];
  message: string;
}

/** HTTP status codes that are safe to retry (transient). */
const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Maximum number of retries for transient upstream failures. */
const MAX_RETRIES = 2;

/** Base delay (ms) between retries; doubled on each subsequent attempt. */
const RETRY_BASE_DELAY_MS = 800;

/** Socket-level timeout for streaming requests (ms). */
const STREAM_SOCKET_TIMEOUT_MS = 600_000;

/** Socket-level timeout for non-streaming requests (ms). */
const NON_STREAM_SOCKET_TIMEOUT_MS = 120_000;

/**
 * If no data is received for this long during a stream, abort (ms).
 * Reasoning models can stay silent for a long time while "thinking" and
 * agent turns that follow a slow tool call also pause — a short window here
 * was cutting long runs off mid-task.
 */
const STREAM_INACTIVITY_TIMEOUT_MS = 300_000;

/** TCP keep-alive probe interval (ms). */
const KEEP_ALIVE_INTERVAL_MS = 15_000;

export class OpenAiClient {
  public static async listModels(baseUrl: string, apiKey: string): Promise<ModelsResult> {
    if (!baseUrl || baseUrl.trim().length === 0) {
      return { success: false, models: [], message: "No base URL configured." };
    }

    try {
      const endpoint = baseUrl.trim().replace(/\/$/, "");
      const modelsUrl = `${endpoint}/models`;
      const urlObj = new URL(modelsUrl);

      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Accept": "application/json"
        },
        timeout: 5000
      };

      const requester = urlObj.protocol === "https:" ? https : http;

      return new Promise<ModelsResult>((resolve) => {
        const req = requester.request(options, (res: any) => {
          let body = "";
          res.on("data", (chunk: any) => body += chunk);
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                let modelIds: string[] = [];
                if (Array.isArray(parsed.data)) {
                  modelIds = parsed.data.map((item: any) => typeof item === "string" ? item : item.id).filter(Boolean);
                } else if (Array.isArray(parsed)) {
                  modelIds = parsed.map((item: any) => typeof item === "string" ? item : item.id).filter(Boolean);
                }
                resolve({ success: true, models: modelIds, message: `Discovered ${modelIds.length} models.` });
              } catch (e: any) {
                resolve({ success: false, models: [], message: `Failed to parse models response: ${e.message}` });
              }
            } else {
              resolve({ success: false, models: [], message: `HTTP ${res.statusCode}: ${body}` });
            }
          });
        });

        req.on("error", (err: any) => {
          resolve({ success: false, models: [], message: `Request error: ${err.message}` });
        });

        req.on("timeout", () => {
          req.destroy();
          resolve({ success: false, models: [], message: "Connection timed out." });
        });

        req.end();
      });
    } catch (e: any) {
      return { success: false, models: [], message: `Invalid URL: ${e.message}` };
    }
  }

  /**
   * Configure socket-level keep-alive and timeouts on a Node.js request.
   * This prevents corporate firewalls (Zscaler, etc.) from silently
   * killing idle TCP connections during long agent operations.
   */
  private static configureSocket(req: any, timeoutMs: number): void {
    req.setTimeout(timeoutMs, () => {
      console.warn(`[Copilot Pulse] Request timeout after ${timeoutMs}ms — aborting request`);
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on("socket", (socket: any) => {
      if (typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, KEEP_ALIVE_INTERVAL_MS);
      }
    });
  }

  public static streamChatCompletions(
    baseUrl: string,
    apiKey: string,
    payload: string,
    onData: (chunk: string) => void,
    onError: (err: Error) => void,
    onEnd: () => void
  ): void {
    // `settled` guarantees onEnd/onError fire exactly once across all retries.
    // Without it a late socket 'error' after 'end' would emit a spurious error
    // chunk into an already-finished stream (or vice-versa), which VS Code
    // interprets as a malformed response and aborts the run.
    const state = { settled: false, receivedData: false };

    const safeEnd = () => {
      if (state.settled) return;
      state.settled = true;
      onEnd();
    };
    const safeError = (err: Error) => {
      if (state.settled) return;
      state.settled = true;
      onError(err);
    };
    const safeData = (chunk: string) => {
      if (state.settled) return;
      state.receivedData = true;
      onData(chunk);
    };

    this._streamWithRetry(baseUrl, apiKey, payload, safeData, safeError, safeEnd, 0, state);
  }

  /**
   * Internal: streaming request with retry support for transient failures.
   */
  private static _streamWithRetry(
    baseUrl: string,
    apiKey: string,
    payload: string,
    onData: (chunk: string) => void,
    onError: (err: Error) => void,
    onEnd: () => void,
    attempt: number,
    state: { settled: boolean; receivedData: boolean }
  ): void {
    const endpoint = baseUrl.trim().replace(/\/$/, "");
    const urlObj = new URL(`${endpoint}/chat/completions`);
    const requester = urlObj.protocol === "https:" ? https : http;

    const payloadBytes = Buffer.from(payload, "utf-8");

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": payloadBytes.length,
        "Accept": "text/event-stream"
      }
    };

    const req = requester.request(options, (res: any) => {
      const statusCode = res.statusCode || 200;

      // Retryable transient error?
      if (RETRYABLE_STATUS_CODES.has(statusCode) && attempt < MAX_RETRIES) {
        // Drain the response body before retrying
        let errorBody = "";
        res.on("data", (chunk: Buffer) => errorBody += chunk.toString("utf-8"));
        res.on("end", () => {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          // If 429, check for Retry-After header
          const retryAfter = res.headers["retry-after"];
          const actualDelay = retryAfter ? Math.max(delay, parseInt(retryAfter, 10) * 1000 || delay) : delay;
          console.warn(
            `[Copilot Pulse] Stream got HTTP ${statusCode}, retrying in ${actualDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorBody.slice(0, 200)}`
          );
          setTimeout(() => {
            this._streamWithRetry(baseUrl, apiKey, payload, onData, onError, onEnd, attempt + 1, state);
          }, actualDelay);
        });
        return;
      }

      if (statusCode >= 400) {
        let errorBody = "";
        res.on("data", (chunk: Buffer) => errorBody += chunk.toString("utf-8"));
        res.on("end", () => {
          onError(new Error(`HTTP ${statusCode} from provider: ${errorBody}`));
        });
        return;
      }

      // ── Inactivity timeout: if no data arrives for STREAM_INACTIVITY_TIMEOUT_MS, abort ──
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

      const resetInactivityTimer = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          console.warn(`[Copilot Pulse] Stream inactivity timeout (${STREAM_INACTIVITY_TIMEOUT_MS}ms) — aborting`);
          req.destroy(new Error(`Stream inactivity timeout after ${STREAM_INACTIVITY_TIMEOUT_MS}ms`));
        }, STREAM_INACTIVITY_TIMEOUT_MS);
      };

      resetInactivityTimer();

      res.on("data", (chunk: Buffer) => {
        resetInactivityTimer();
        onData(chunk.toString("utf-8"));
      });

      res.on("end", () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        onEnd();
      });

      // 'aborted' fires when the upstream closes the socket before the response
      // is complete. Node does NOT always follow it with an 'error' event, so
      // without this handler the stream would silently hang forever.
      res.on("aborted", () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        onError(new Error("Upstream closed the connection before the response completed"));
      });

      res.on("error", (err: any) => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        onError(err);
      });
    });

    // Socket-level timeout and keep-alive
    this.configureSocket(req, STREAM_SOCKET_TIMEOUT_MS);

    req.on("error", (err: any) => {
      // Retry on connection-level errors (ECONNRESET, EPIPE, etc.) — but ONLY
      // if we have not already streamed data to the client. Retrying after
      // partial delivery would replay the answer from the beginning and
      // produce duplicated/garbled output.
      const retryable = err.code === "ECONNRESET" || err.code === "EPIPE" || err.code === "ECONNREFUSED";
      if (attempt < MAX_RETRIES && retryable && !state.receivedData && !state.settled) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Copilot Pulse] Stream connection error (${err.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        setTimeout(() => {
          this._streamWithRetry(baseUrl, apiKey, payload, onData, onError, onEnd, attempt + 1, state);
        }, delay);
        return;
      }
      onError(err);
    });

    req.write(payloadBytes);
    req.end();
  }

  /**
   * Non-streaming chat completions request. Used when Copilot Agent sends
   * `stream: false` (e.g., for tool-call planning or short utility requests).
   */
  public static nonStreamChatCompletions(
    baseUrl: string,
    apiKey: string,
    payload: string,
    onSuccess: (body: string) => void,
    onError: (err: Error) => void
  ): void {
    this._nonStreamWithRetry(baseUrl, apiKey, payload, onSuccess, onError, 0);
  }

  /**
   * Internal: non-streaming request with retry support for transient failures.
   */
  private static _nonStreamWithRetry(
    baseUrl: string,
    apiKey: string,
    payload: string,
    onSuccess: (body: string) => void,
    onError: (err: Error) => void,
    attempt: number
  ): void {
    const endpoint = baseUrl.trim().replace(/\/$/, "");
    const urlObj = new URL(`${endpoint}/chat/completions`);
    const requester = urlObj.protocol === "https:" ? https : http;

    const payloadBytes = Buffer.from(payload, "utf-8");

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": payloadBytes.length,
        "Accept": "application/json"
      }
    };

    const req = requester.request(options, (res: any) => {
      const statusCode = res.statusCode || 200;
      let body = "";
      res.on("data", (chunk: Buffer) => body += chunk.toString("utf-8"));
      res.on("end", () => {
        // Retryable transient error?
        if (RETRYABLE_STATUS_CODES.has(statusCode) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          const retryAfter = res.headers["retry-after"];
          const actualDelay = retryAfter ? Math.max(delay, parseInt(retryAfter, 10) * 1000 || delay) : delay;
          console.warn(
            `[Copilot Pulse] Non-stream got HTTP ${statusCode}, retrying in ${actualDelay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${body.slice(0, 200)}`
          );
          setTimeout(() => {
            this._nonStreamWithRetry(baseUrl, apiKey, payload, onSuccess, onError, attempt + 1);
          }, actualDelay);
          return;
        }

        if (statusCode >= 400) {
          onError(new Error(`HTTP ${statusCode} from provider: ${body}`));
        } else {
          onSuccess(body);
        }
      });
    });

    // Socket-level timeout and keep-alive
    this.configureSocket(req, NON_STREAM_SOCKET_TIMEOUT_MS);

    req.on("error", (err: any) => {
      // Retry on connection-level errors
      if (attempt < MAX_RETRIES && (err.code === "ECONNRESET" || err.code === "EPIPE" || err.code === "ECONNREFUSED")) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Copilot Pulse] Non-stream connection error (${err.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );
        setTimeout(() => {
          this._nonStreamWithRetry(baseUrl, apiKey, payload, onSuccess, onError, attempt + 1);
        }, delay);
        return;
      }
      onError(err);
    });

    req.write(payloadBytes);
    req.end();
  }
}
