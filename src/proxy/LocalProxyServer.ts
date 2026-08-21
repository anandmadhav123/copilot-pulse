import * as http from "http";
import * as https from "https";
import * as net from "net";
import { RouterLogic, RouterConfig, Decision } from "./RouterLogic";
import { RoutingContext } from "../routing/PromptFeatures";
import { OpenAiClient } from "./OpenAiClient";
import { CopilotAuth } from "./CopilotAuth";

/** TCP keep-alive probe interval (ms). */
const KEEP_ALIVE_INTERVAL_MS = 15_000;


/**
 * Tracks the terminal state of an outgoing SSE stream so we can guarantee the
 * client always receives a `finish_reason` chunk followed by `data: [DONE]`.
 *
 * Without this, an upstream provider that closes the socket mid-response makes
 * VS Code's Copilot client see the response "just stop" with no error — the
 * classic "extension stops abruptly in between" symptom.
 */
export interface SseState {
  sawDone: boolean;
  sawFinish: boolean;
  sawContent: boolean;
}

export interface MetricRecord {
  timestamp: number;
  routedModel: String;
  model: string;
  prompt: string;
  promptSnippet: string;
  taskType: string;
  complexityScore: number;
  score: number;
  tier: string;
  savings: boolean;
  simulatedSavings: number;
  latencyMs: number;
  signals?: {
    keyword?: number;
    intent?: number;
    code?: number;
    context?: number;
    vector?: number;
  };
}

export class LocalProxyServer {
  private static instance: LocalProxyServer | null = null;
  private server: http.Server | null = null;
  private readonly PORT = 3456;
  private metrics: MetricRecord[] = [];
  private configGetter: () => RouterConfig;
  private onMetricListener: (() => void) | null = null;
  // Callback to allow routing the parsed HTTP request back to the native vscode.lm API
  public nativeRouteCallback?: (
    requestJson: any,
    res: http.ServerResponse,
    isStreaming: boolean,
    requestedModel: string,
    record: any,
    onFinish: () => void,
    onError: (err: Error) => void
  ) => void;

  private constructor(configGetter: () => RouterConfig) {
    this.configGetter = configGetter;
  }

  public static getInstance(configGetter?: () => RouterConfig): LocalProxyServer {
    if (!this.instance) {
      this.instance = new LocalProxyServer(configGetter || (() => ({})));
    } else if (configGetter) {
      this.instance.configGetter = configGetter;
    }
    return this.instance;
  }

  public setOnMetricListener(listener: () => void): void {
    this.onMetricListener = listener;
  }

  /**
   * Safe write to an HTTP response. Checks that the response is still
   * writable before attempting to write — prevents "write after end"
   * crashes when the client (VS Code) disconnects mid-stream.
   */
  private safeWrite(res: http.ServerResponse, data: string): boolean {
    try {
      if (res.destroyed || res.writableEnded || res.writableFinished) return false;
      res.write(data);
      return true;
    } catch (e) {
      // Connection already closed by client — swallow silently
      return false;
    }
  }

  /**
   * Safe end to an HTTP response.
   */
  private safeEnd(res: http.ServerResponse): void {
    try {
      if (!res.destroyed && !res.writableEnded && !res.writableFinished) {
        res.end();
      }
    } catch (e) {
      // Already closed
    }
  }

  public start(): Promise<boolean> {
    if (this.server) return Promise.resolve(true);

    return new Promise((resolve) => {
      this.server = http.createServer((req: any, res: any) => {
        const url = req.url || "/";
        const method = req.method || "GET";
        if ((url === "/v1/models" || url === "/models") && method === "GET") {
          this.handleModels(req, res);
        } else if ((url === "/v1/chat/completions" || url === "/chat/completions") && (method === "POST" || method === "OPTIONS")) {
          this.handleChatCompletions(req, res);
        } else if (url === "/metrics" && method === "GET") {
          this.handleMetrics(req, res);
        } else if (url === "/" || url === "/dashboard") {
          this.handleDashboard(req, res);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      });

      // Enable TCP keep-alive on all incoming connections
      this.server.on("connection", (socket: net.Socket) => {
        socket.setKeepAlive(true, KEEP_ALIVE_INTERVAL_MS);
      });

      this.server.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.log(`[Copilot Pulse] Port ${this.PORT} already in use (another IDE instance running).`);
          this.server = null;
          resolve(true);
        } else {
          console.error("[Copilot Pulse] Server error:", err);
          this.server = null;
          resolve(false);
        }
      });

      this.server.listen(this.PORT, "127.0.0.1", () => {
        // Server-level timeouts to prevent hung connections
        if (this.server) {
          this.server.keepAliveTimeout = 120_000;  // 2 minutes
          this.server.headersTimeout = 65_000;     // 65 seconds
        }
        console.log(`[Copilot Pulse] Proxy server running on http://127.0.0.1:${this.PORT}`);
        resolve(true);
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[Copilot Pulse] Proxy server stopped.");
    }
  }

  public getMetrics(): MetricRecord[] {
    return [...this.metrics];
  }

  /**
   * Directly record a chat metric when the chat participant runs without the
   * local HTTP proxy but must still populate the Metrics & Savings view.
   * Returns the routing decision so the caller can display it.
   */
  public recordChatMetric(
    prompt: string,
    config: RouterConfig,
    latencyMs: number = 0,
    hasTools: boolean = false,
    ctx: RoutingContext = {}
  ): Decision {
    const cleanPrompt = RouterLogic.extractCleanPrompt(prompt);
    const decision: Decision = RouterLogic.routeDecision(cleanPrompt, config, hasTools, ctx);
    const taskType = hasTools ? `Agent Tools (${decision.tier})` : (RouterLogic.detectTaskType ? RouterLogic.detectTaskType(cleanPrompt) : "GENERAL");
    const roundedScore = Math.round(decision.score * 10) / 10;

    const record: MetricRecord = {
      timestamp: Date.now(),
      routedModel: decision.model,
      model: decision.model,
      prompt: cleanPrompt || "Copilot Query",
      promptSnippet: (cleanPrompt || "Copilot Query").slice(0, 80),
      taskType,
      complexityScore: roundedScore,
      score: roundedScore,
      tier: decision.tier,
      savings: decision.savings,
      simulatedSavings: decision.savings ? 0.014 : 0.0,
      latencyMs,
      signals: {
        keyword: Math.min(9, Math.round(decision.score * 0.9)),
        intent: Math.min(9, Math.round(decision.score * 1.1)),
        code: cleanPrompt.includes("```") ? 8 : 2,
        context: Math.min(9, Math.round(cleanPrompt.length / 50)),
        vector: Math.min(9, Math.round(decision.score * 0.8))
      }
    };

    this.recordMetric(record);
    return decision;
  }

  private handleModels(req: http.IncomingMessage, res: http.ServerResponse): void {
    const response = JSON.stringify({
      object: "list",
      data: [
        { id: "copilot-pulse", object: "model", created: 1785897097, owned_by: "copilot-pulse" },
        { id: "copilot-pulse-agent", object: "model", created: 1785897097, owned_by: "copilot-pulse" },
        { id: "copilot-pulse-router", object: "model", created: 1785897097, owned_by: "copilot-pulse" }
      ]
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response);
  }

  /**
   * Extract the user-facing text from the last user message in an OpenAI messages
   * array. Handles both `content: "string"` and `content: [{type:"text", text:"..."}]`
   * shapes that Copilot Agent mode may send.
   */
  private extractPromptText(messages: any[]): string {
    if (!Array.isArray(messages) || messages.length === 0) return "";

    // Walk backwards to find the last user message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;
      if (msg.role && msg.role !== "user") continue;

      const content = msg.content;
      if (typeof content === "string") return content;

      // content: [{type: "text", text: "..."}] — agent mode
      if (Array.isArray(content)) {
        let text = "";
        for (const part of content) {
          if (typeof part === "string") text += part;
          else if (part && typeof part.text === "string") text += part.text;
          else if (part && typeof part.content === "string") text += part.content;
        }
        if (text.trim().length > 0) return text;
      }
    }

    // Fallback: last message regardless of role
    const last = messages[messages.length - 1];
    if (last && typeof last.content === "string") return last.content;
    return "";
  }

  private tryParseJson(buffer: { text: string }, jsonStr: string): string | null {
    // 1. If jsonStr alone is valid JSON, parse immediately and clear any stale buffer
    try {
      JSON.parse(jsonStr);
      buffer.text = "";
      return jsonStr;
    } catch {
      // Not valid JSON alone — might be continuation of previous fragment
    }

    // 2. Try combining with existing buffer
    if (buffer.text) {
      const candidate = buffer.text + jsonStr;
      try {
        JSON.parse(candidate);
        buffer.text = "";
        return candidate;
      } catch {
        // Still not complete
      }
    }

    // 3. Accumulate candidate
    buffer.text = buffer.text ? buffer.text + jsonStr : jsonStr;
    if (buffer.text.length > 32768) {
      console.warn("[Copilot Pulse] Dropping oversized SSE chunk buffer");
      buffer.text = "";
    }
    return null;
  }

  private processSseChunk(
    rawChunk: string,
    res: http.ServerResponse,
    chunkBuffer: { text: string },
    lineRemainder: { text: string },
    requestedModel: string,
    state?: SseState
  ): void {
    const fullText = lineRemainder.text + rawChunk;
    const lines = fullText.split(/\r?\n/);
    lineRemainder.text = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "data: [DONE]") {
        if (state) state.sawDone = true;
        this.safeWrite(res, "data: [DONE]\n\n");
        continue;
      }
      if (trimmed.startsWith("data: ")) {
        const jsonStr = trimmed.slice(6).trim();
        const validJson = this.tryParseJson(chunkBuffer, jsonStr);
        if (!validJson) continue;
        
        // Skip metadata chunks (like OpenRouter generation IDs) that lack choices,
        // as VS Code's native Copilot client may crash on them.
        if (!validJson.includes('"choices"')) {
          continue;
        }

        const rewritten = validJson.replace(/\"model\":\"[^\"]+\"/g, `"model":"${requestedModel}"`);
        this.markState(state, rewritten);
        this.safeWrite(res, `data: ${rewritten}\n\n`);
      } else if (trimmed.startsWith(":")) {
        this.safeWrite(res, `${trimmed}\n\n`);
      }
    }
  }

  /** Record whether a forwarded chunk carried content and/or a finish_reason. */
  private markState(state: SseState | undefined, chunkJson: string): void {
    if (!state) return;
    state.sawContent = true;
    if (/"finish_reason"\s*:\s*"[^"]+"/.test(chunkJson)) {
      state.sawFinish = true;
    }
  }

  /**
   * Guarantees a well-formed end of stream for the client.
   *
   * If the upstream provider dropped the connection without sending a
   * `finish_reason` chunk and/or `data: [DONE]`, we synthesize them. VS Code's
   * Copilot client requires both — otherwise the response silently truncates
   * (and in agent mode the whole run stops mid-task).
   */
  private finalizeStream(res: http.ServerResponse, requestedModel: string, state: SseState, reason: string = "stop"): void {
    if (!state.sawFinish) {
      const finalChunk =
        `data: {"id":"pulse_final","object":"chat.completion.chunk","model":"${requestedModel}",` +
        `"choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}]}\n\n`;
      this.safeWrite(res, finalChunk);
      state.sawFinish = true;
    }
    if (!state.sawDone) {
      this.safeWrite(res, "data: [DONE]\n\n");
      state.sawDone = true;
    }
  }

  /**
   * Flush any remaining data in the lineRemainder and chunkBuffer after the
   * upstream stream ends. This prevents data loss when the final SSE chunk
   * doesn't end with a newline (common with some providers).
   */
  private flushSseBuffers(
    res: http.ServerResponse,
    chunkBuffer: { text: string },
    lineRemainder: { text: string },
    requestedModel: string,
    state?: SseState
  ): void {
    // Process any remaining text in lineRemainder
    if (lineRemainder.text.trim().length > 0) {
      const trimmed = lineRemainder.text.trim();
      lineRemainder.text = "";

      if (trimmed === "data: [DONE]") {
        if (state) state.sawDone = true;
        this.safeWrite(res, "data: [DONE]\n\n");
        return;
      }

      if (trimmed.startsWith("data: ")) {
        const jsonStr = trimmed.slice(6).trim();
        const validJson = this.tryParseJson(chunkBuffer, jsonStr);
        if (validJson && validJson.includes('"choices"')) {
          const rewritten = validJson.replace(/\"model\":\"[^\"]+\"/g, `"model":"${requestedModel}"`);
          this.markState(state, rewritten);
          this.safeWrite(res, `data: ${rewritten}\n\n`);
        }
      }
    }

    // If chunkBuffer still has data, try to parse and emit it
    if (chunkBuffer.text.trim().length > 0) {
      try {
        const parsed = JSON.parse(chunkBuffer.text);
        chunkBuffer.text = "";
        const jsonStr = JSON.stringify(parsed);
        if (jsonStr.includes('"choices"')) {
          const rewritten = jsonStr.replace(/\"model\":\"[^\"]+\"/g, `"model":"${requestedModel}"`);
          this.markState(state, rewritten);
          this.safeWrite(res, `data: ${rewritten}\n\n`);
        }
      } catch {
        // Truly incomplete JSON — discard
        console.warn(`[Copilot Pulse] Discarding incomplete chunkBuffer (${chunkBuffer.text.length} chars)`);
        chunkBuffer.text = "";
      }
    }
  }

  private handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Handle CORS preflight (Agent host may send OPTIONS)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      });
      res.end();
      return;
    }

    const startTime = Date.now();
    let bodyStr = "";

    // If the client aborts while uploading the body, bail out quietly instead
    // of letting an unhandled 'error' event tear down the extension host.
    req.on("error", (reqErr: any) => {
      console.warn("[Copilot Pulse] Inbound request error:", reqErr?.message || reqErr);
      this.safeEnd(res);
    });
    res.on("error", (resErr: any) => {
      console.warn("[Copilot Pulse] Response socket error:", resErr?.message || resErr);
    });

    req.on("data", (chunk: any) => bodyStr += chunk);
    req.on("end", () => {
      try {
        const requestJson = JSON.parse(bodyStr);
        const requestedModel = requestJson.model || "copilot-pulse";
        const isStreaming = requestJson.stream !== false; // default to streaming

        const promptText = this.extractPromptText(requestJson.messages);
        const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
        const isRouterModel = !requestJson.model || 
          requestJson.model === "copilot-pulse" || 
          requestJson.model === "copilot-pulse-agent" ||
          requestJson.model.includes("copilot-pulse");
        const isUtilityRequest = !isRouterModel;
        const isToolFollowUp = Array.isArray(requestJson.messages) &&
          requestJson.messages.some((m: any) => m.role === "tool" || m.role === "function");
        const shouldInjectBadge = !isUtilityRequest && !isToolFollowUp;

        // Detect Agent Mode: request contains tools or functions definitions
        const hasTools = (Array.isArray(requestJson.tools) && requestJson.tools.length > 0) ||
                         (Array.isArray(requestJson.functions) && requestJson.functions.length > 0);
        
        const config = this.configGetter();
        let decision: Decision;
        let roundedScore = 0;
        let taskType = "GENERAL";

        if (isUtilityRequest) {
          // Bypass routing for internal Copilot utility/embedding requests
          decision = {
            model: requestJson.model,
            score: 0,
            tier: "Utility",
            savings: false
          };
        } else {
          decision = RouterLogic.routeDecision(cleanPrompt, config, hasTools);
          taskType = hasTools ? `Agent Tools (${decision.tier})` : (RouterLogic.detectTaskType ? RouterLogic.detectTaskType(cleanPrompt) : "GENERAL");
          roundedScore = Math.round(decision.score * 10) / 10;
        }

        // Always create a record object to satisfy downstream references,
        // but only save it to metrics if it's a real user request.
        const record: MetricRecord = {
          timestamp: startTime,
          routedModel: decision.model,
          model: decision.model,
          prompt: cleanPrompt || "Copilot Query",
          promptSnippet: (cleanPrompt || "Copilot Query").slice(0, 80),
          taskType,
          complexityScore: roundedScore,
          score: roundedScore,
          tier: decision.tier,
          savings: decision.savings,
          simulatedSavings: decision.savings ? 0.014 : 0.0,
          latencyMs: 0,
          signals: {
            keyword: Math.min(9, Math.round(decision.score * 0.9)),
            intent: Math.min(9, Math.round(decision.score * 1.1)),
            code: cleanPrompt.includes("```") ? 8 : 2,
            context: Math.min(9, Math.round(cleanPrompt.length / 50)),
            vector: Math.min(9, Math.round(decision.score * 0.8))
          }
        };

        if (!isUtilityRequest) {
          this.recordMetric(record);
        }

        console.log(
          `[Copilot Pulse] Routing → ${decision.model} (score=${roundedScore}, tier=${decision.tier}, stream=${isStreaming}, hasTools=${hasTools})`
        );

        // Payload mutations — route to the chosen upstream model
        requestJson.model = decision.model;
        if (isStreaming && requestJson.stream === undefined) {
          requestJson.stream = true;
        }
        // Strip Copilot-internal fields the upstream provider won't understand
        const copilotFields = ["intent", "copilot_references", "copilot_thread_id", "nwo"];
        for (const field of copilotFields) {
          delete requestJson[field];
        }

        let finalModelId = decision.model;
        if (this.nativeRouteCallback) {
          // Copilot API does not use vendor prefixes
          if (finalModelId.includes("/")) {
            finalModelId = finalModelId.split("/").pop() || finalModelId;
          }
        }
        requestJson.model = finalModelId;
        record.routedModel = finalModelId;

        const newPayload = JSON.stringify(requestJson);
        const chunkBuffer = { text: "" };
        const lineRemainder = { text: "" };
        const sseState: SseState = { sawDone: false, sawFinish: false, sawContent: false };

        if (this.nativeRouteCallback) {
          // Native Bridge Mode: Direct HTTP proxy to api.githubcopilot.com
          (async () => {
            // ── Client disconnect detection ──
            // If the VSCode client closes the connection (cancel, timeout),
            // abort the upstream fetch to prevent zombie connections.
            let clientDisconnected = false;
            let abortController: any = null;
            try { abortController = new (globalThis as any).AbortController(); } catch { /* older Node */ }

            res.on("close", () => {
              clientDisconnected = true;
              if (abortController) abortController.abort();
            });

            try {
              const copilotToken = await CopilotAuth.getCopilotToken();
              
              if (isStreaming) {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  "Connection": "keep-alive",
                  "Access-Control-Allow-Origin": "*"
                });
                
                if (shouldInjectBadge) {
                  // Inject visual badge for user-facing chat responses only
                  const badgeMsg = `⚡ Copilot Pulse routed to: **${decision.model}**\\n\\n`;
                  const badgeChunk = `data: {"id":"pulse_badge","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"${badgeMsg}"}}]}\n\n`;
                  this.safeWrite(res, badgeChunk);
                }
              } else {
                res.writeHead(200, {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*"
                });
              }

              // Copy headers from original request to keep telemetry happy
              const forwardHeaders: any = {
                "Authorization": `Bearer ${copilotToken}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(newPayload),
                "Accept": "application/json, text/event-stream"
              };
              
              const safeHeaders = ["vscode-sessionid", "vscode-machineid", "editor-version", "editor-plugin-version", "copilot-integration-id", "x-request-id", "x-github-api-version", "user-agent"];
              for (const h of safeHeaders) {
                if (req.headers[h]) forwardHeaders[h] = req.headers[h];
              }

              // Send the request payload directly to Copilot API using global fetch
              // This is crucial because global fetch in the VS Code extension host
              // automatically inherits the system proxy and certificate settings,
              // bypassing enterprise firewalls like Zscaler!
              try {
                const fetchOpts: any = {
                  method: "POST",
                  headers: forwardHeaders,
                  body: newPayload
                };
                if (abortController) fetchOpts.signal = abortController.signal;

                const fetchReq = await (globalThis as any).fetch("https://api.githubcopilot.com/chat/completions", fetchOpts);

                const isError = !fetchReq.ok;
                if (isError) {
                  const errorBody = await fetchReq.text();
                  let errMsg = `Copilot API Error ${fetchReq.status}: ${errorBody}`.replace(/"/g, '\\"').replace(/\n/g, ' ');
                  if (isStreaming) {
                    const errorChunk1 = `data: {"id":"error","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"\\n\\n**Copilot API Error:** ${errMsg}"}}]}\n\n`;
                    this.safeWrite(res, errorChunk1);
                    this.finalizeStream(res, requestedModel, sseState);
                  } else {
                    this.safeWrite(res, JSON.stringify({ error: errMsg }));
                  }
                  record.latencyMs = Date.now() - startTime;
                  if (this.onMetricListener) this.onMetricListener();
                  this.safeEnd(res);
                  return;
                }

                if (!fetchReq.body) {
                  throw new Error("Empty response body from Copilot API");
                }

                // Process the stream cleanly.
                // NOTE: a mid-stream read failure must NOT kill the response —
                // we flush what we have and close the stream properly so the
                // client sees a complete (if truncated) answer instead of an
                // abrupt hang.
                let streamReadError: Error | null = null;
                // @ts-ignore - ReadableStream in Node.js / VS Code has asyncIterator or we can use getReader
                if (fetchReq.body.getReader) {
                  const reader = (fetchReq.body as any).getReader();
                  const decoder = new (globalThis as any).TextDecoder("utf-8");
                  try {
                    while (true) {
                      if (clientDisconnected) {
                        try { await reader.cancel(); } catch { /* ignore */ }
                        break;
                      }
                      const { done, value } = await reader.read();
                      if (done) break;
                      const chunkStr = decoder.decode(value, { stream: true });
                      this.processSseChunk(chunkStr, res, chunkBuffer, lineRemainder, requestedModel, sseState);
                    }
                  } catch (readErr: any) {
                    streamReadError = readErr;
                  }
                } else {
                  // Fallback for some Node environments
                  try {
                    for await (const chunk of fetchReq.body as any) {
                      if (clientDisconnected) break;
                      const chunkStr = chunk.toString();
                      this.processSseChunk(chunkStr, res, chunkBuffer, lineRemainder, requestedModel, sseState);
                    }
                  } catch (readErr: any) {
                    streamReadError = readErr;
                  }
                }

                if (streamReadError && !clientDisconnected) {
                  console.error("[Copilot Pulse] Upstream stream interrupted:", streamReadError);
                  if (isStreaming) {
                    const errMsg = (streamReadError.message || "connection interrupted")
                      .replace(/"/g, '\\"')
                      .replace(/\n/g, " ");
                    const noticeChunk =
                      `data: {"id":"pulse_interrupt","object":"chat.completion.chunk","model":"${requestedModel}",` +
                      `"choices":[{"index":0,"delta":{"content":"\\n\\n_[Copilot Pulse] Upstream stream interrupted: ${errMsg}. Please retry._"}}]}\n\n`;
                    this.safeWrite(res, noticeChunk);
                  }
                }

                // ── Flush remaining data in buffers (Bug 3 & 4 fix) ──
                this.flushSseBuffers(res, chunkBuffer, lineRemainder, requestedModel, sseState);

                // ── Guarantee finish_reason + [DONE] so the client never hangs ──
                if (isStreaming && !clientDisconnected) {
                  this.finalizeStream(res, requestedModel, sseState);
                }

                record.latencyMs = Date.now() - startTime;
                if (this.onMetricListener) this.onMetricListener();
                this.safeEnd(res);
              } catch (err: any) {
                // Ignore AbortError from client disconnect
                if (err.name === "AbortError" || clientDisconnected) {
                  console.log("[Copilot Pulse] Client disconnected, upstream fetch aborted.");
                  record.latencyMs = Date.now() - startTime;
                  if (this.onMetricListener) this.onMetricListener();
                  return;
                }
                console.error("[Copilot Pulse] Direct routing network error:", err);
                if (isStreaming) {
                  const errMsg = (err.message || "Unknown error").replace(/"/g, '\\"').replace(/\n/g, ' ');
                  const errorChunk = `data: {"id":"error","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"\\n\\n**Copilot Pulse Error:** ${errMsg}"}}]}\n\n`;
                  this.safeWrite(res, errorChunk);
                  this.finalizeStream(res, requestedModel, sseState);
                } else {
                  this.safeWrite(res, JSON.stringify({ error: err.message }));
                }
                record.latencyMs = Date.now() - startTime;
                if (this.onMetricListener) this.onMetricListener();
                this.safeEnd(res);
              }
            } catch (err: any) {
              console.error("[Copilot Pulse] Direct routing auth error:", err);
              if (isStreaming) {
                try {
                  res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*"
                  });
                } catch { /* headers may already be sent */ }
                const errMsg = (err.message || "Unknown error").replace(/"/g, '\\"').replace(/\n/g, ' ');
                const errorChunk = `data: {"id":"error","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"\\n\\n**Copilot Pulse Error:** ${errMsg}"}}]}\n\n`;
                this.safeWrite(res, errorChunk);
                this.finalizeStream(res, requestedModel, sseState);
                this.safeEnd(res);
              } else {
                try {
                  res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
                } catch { /* headers may already be sent */ }
                this.safeEnd(res);
              }
            }
          })();
          return;
        }

        if (!config.baseUrl || !config.apiKey) {
          const errMsg = "Copilot Pulse is not configured. Please set 'Copilot Pulse: Api Key' in your VS Code Settings.";
          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
              "Access-Control-Allow-Origin": "*"
            });
            const errorChunk = `data: {"id":"error","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"\\n\\n**⚠️ Configuration Required:** ${errMsg}"},"finish_reason":"stop"}]}\n\n`;
            res.write(errorChunk);
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
            res.end(JSON.stringify({ error: { message: errMsg, type: "configuration_error" } }));
          }
          return;
        }

        if (isStreaming) {
          // ── Streaming mode ──
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          });

          if (shouldInjectBadge) {
            // Inject visual badge
            const badgeMsg = `⚡ Copilot Pulse routed to: **${decision.model}**\\n\\n`;
            const badgeChunk = `data: {"id":"pulse_badge","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"${badgeMsg}"}}]}\n\n`;
            this.safeWrite(res, badgeChunk);
          }

          // ── Client disconnect detection (zombie connection prevention) ──
          let clientClosed = false;
          res.on("close", () => { clientClosed = true; });

          OpenAiClient.streamChatCompletions(
            config.baseUrl,
            config.apiKey,
            newPayload,
            (chunk: string) => {
              if (clientClosed) return; // Don't process if client disconnected
              this.processSseChunk(chunk, res, chunkBuffer, lineRemainder, requestedModel, sseState);
            },
            (err: Error) => {
              if (clientClosed) {
                console.log("[Copilot Pulse] Client disconnected during stream (error path).");
                record.latencyMs = Date.now() - startTime;
                if (this.onMetricListener) this.onMetricListener();
                return;
              }
              console.error("[Copilot Pulse] Stream error:", err);
              try {
                // Flush whatever partial content we already buffered so the
                // user keeps the text produced before the failure.
                this.flushSseBuffers(res, chunkBuffer, lineRemainder, requestedModel, sseState);
                const errMsg = (err.message || "Unknown error").replace(/"/g, '\\"').replace(/\n/g, ' ');
                const errorChunk = `data: {"id":"error","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"\\n\\n**Copilot Pulse Error:** ${errMsg}"}}]}\n\n`;
                this.safeWrite(res, errorChunk);
                this.finalizeStream(res, requestedModel, sseState);
              } catch (e) {}
              record.latencyMs = Date.now() - startTime;
              if (this.onMetricListener) this.onMetricListener();
              this.safeEnd(res);
            },
            () => {
              // ── Flush remaining data in buffers (Bug 3 & 4 fix) ──
              this.flushSseBuffers(res, chunkBuffer, lineRemainder, requestedModel, sseState);

              // ── Guarantee finish_reason + [DONE] so the client never hangs ──
              if (!clientClosed) {
                this.finalizeStream(res, requestedModel, sseState);
              }

              record.latencyMs = Date.now() - startTime;
              if (this.onMetricListener) this.onMetricListener();
              this.safeEnd(res);
            }
          );
        } else {
          // ── Non-streaming mode (some agent requests use stream=false) ──
          OpenAiClient.nonStreamChatCompletions(
            config.baseUrl,
            config.apiKey,
            newPayload,
            (body: string) => {
              record.latencyMs = Date.now() - startTime;
              if (this.onMetricListener) this.onMetricListener();
              // Rewrite model name
              const rewritten = body.replace(/\"model\":\"[^\"]+\"/g, `"model":"${requestedModel}"`);
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              });
              res.end(rewritten);
            },
            (err: Error) => {
              console.error("[Copilot Pulse] Non-stream error:", err);
              record.latencyMs = Date.now() - startTime;
              if (this.onMetricListener) this.onMetricListener();
              res.writeHead(502, {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
              });
              res.end(JSON.stringify({ error: { message: err.message || "Upstream error", type: "proxy_error" } }));
            }
          );
        }
      } catch (e: any) {
        console.error("[Copilot Pulse] Error parsing chat completions payload:", e);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON request" }));
      }
    });
  }

  private handleMetrics(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(this.metrics));
  }

  private handleDashboard(req: http.IncomingMessage, res: http.ServerResponse): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Copilot Pulse — Intelligence & Savings Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #090a16;
      color: #e2e8f0;
      min-height: 100vh;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      background: linear-gradient(135deg, #11132b 0%, #090a16 100%);
      border-bottom: 1px solid rgba(255,255,255,0.08);
      padding: 20px 36px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 800;
      background: linear-gradient(135deg, #00d2ff, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    .header .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #2ecc71;
      background: rgba(46,204,113,0.1);
      padding: 3px 9px;
      border-radius: 12px;
      font-weight: 600;
    }
    .header .status .dot {
      width: 6px; height: 6px;
      background: #2ecc71;
      border-radius: 50%;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .dashboard-body {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px 36px;
    }

    /* KPI Grid */
    .stats {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      padding: 16px 14px;
      backdrop-filter: blur(10px);
      transition: transform 0.2s, border-color 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      border-color: rgba(0,210,255,0.3);
    }
    .stat-card .label {
      font-size: 10px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }
    .stat-card .value {
      font-size: 22px;
      font-weight: 800;
      margin-top: 6px;
      letter-spacing: -0.5px;
    }
    .stat-card .value.purple { color: #a78bfa; }
    .stat-card .value.blue { color: #00d2ff; }
    .stat-card .value.green { color: #2ecc71; }
    .stat-card .value.amber { color: #f59e0b; }
    .stat-card .sub {
      font-size: 10px;
      color: #64748b;
      margin-top: 2px;
    }

    /* Visualizer Row */
    .viz-row {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    .viz-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      padding: 16px 20px;
    }
    .viz-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    .viz-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #94a3b8;
    }
    .savings-track {
      height: 20px;
      background: rgba(255,255,255,0.04);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .savings-fill {
      height: 100%;
      border-radius: 10px;
      background: linear-gradient(90deg, #2ecc71, #00d2ff);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      color: #fff;
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .tier-bars-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tier-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tier-name {
      width: 70px;
      font-size: 11px;
      font-weight: 600;
    }
    .tier-track {
      flex: 1;
      height: 10px;
      background: rgba(255,255,255,0.04);
      border-radius: 5px;
      overflow: hidden;
    }
    .tier-fill-light { background: #2ecc71; height: 100%; border-radius: 5px; }
    .tier-fill-medium { background: #f59e0b; height: 100%; border-radius: 5px; }
    .tier-fill-heavy { background: #ef4444; height: 100%; border-radius: 5px; }

    /* Table */
    .table-container {
      background: rgba(255,255,255,0.02);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
      overflow: hidden;
    }
    .table-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .table-header h2 { font-size: 14px; font-weight: 700; }
    .table-header .refresh {
      background: rgba(0,210,255,0.12);
      border: 1px solid rgba(0,210,255,0.3);
      color: #00d2ff;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      transition: all 0.2s;
    }
    .table-header .refresh:hover { background: rgba(0,210,255,0.22); }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    thead th {
      text-align: left;
      padding: 12px 16px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: #64748b;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    tbody td {
      padding: 12px 16px;
      font-size: 12px;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      vertical-align: middle;
    }
    tbody tr:hover { background: rgba(255,255,255,0.02); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill-light { background: rgba(46,204,113,0.15); color: #2ecc71; border: 1px solid rgba(46,204,113,0.3); }
    .pill-medium { background: rgba(245,158,11,0.15); color: #f59e0b; border: 1px solid rgba(245,158,11,0.3); }
    .pill-heavy { background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.3); }
    .pill-task { background: rgba(0,210,255,0.1); color: #00d2ff; }
    .pill-saved { background: rgba(46,204,113,0.12); color: #2ecc71; }
    .pill-full { background: rgba(239,68,68,0.1); color: #f87171; }
    .why-text {
      font-size: 11px;
      color: #94a3b8;
      max-width: 320px;
      line-height: 1.35;
    }
    .prompt-snippet {
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #cbd5e1;
      font-family: monospace;
      font-size: 11px;
    }
    .signals { display: flex; gap: 3px; }
    .signal-dot {
      width: 22px; height: 16px;
      border-radius: 3px;
      font-size: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
    }
    .empty-state { text-align: center; padding: 48px 20px; color: #64748b; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>⚡ Copilot Pulse Dashboard</h1>
      <span class="status"><div class="dot"></div> Live</span>
    </div>
    <div style="font-size:11px;color:#64748b;">Autonomous Model Router & Cost Optimizer</div>
  </div>

  <div class="dashboard-body">
    <!-- Hero KPIs -->
    <div class="stats">
      <div class="stat-card">
        <div class="label">Total Requests</div>
        <div class="value blue" id="totalRequests">0</div>
        <div class="sub">routed sessions</div>
      </div>
      <div class="stat-card">
        <div class="label">Tier 2 (Simple)</div>
        <div class="value green" id="tier2Count">0</div>
        <div class="sub">lightweight models</div>
      </div>
      <div class="stat-card">
        <div class="label">Tier 1 (Complex)</div>
        <div class="value amber" id="tier1Count">0</div>
        <div class="sub">heavy reasoning</div>
      </div>
      <div class="stat-card">
        <div class="label">Avg Score</div>
        <div class="value blue" id="avgScore">0.0</div>
        <div class="sub">/10 complexity</div>
      </div>
      <div class="stat-card">
        <div class="label">Est. Cost Saved</div>
        <div class="value green" id="costSaved">$0.000</div>
        <div class="sub">vs all-premium</div>
      </div>
      <div class="stat-card">
        <div class="label">Credits Saved</div>
        <div class="value purple" id="creditsSaved">0.0</div>
        <div class="sub">premium tokens</div>
      </div>
    </div>

    <!-- Visualizer Row -->
    <div class="viz-row">
      <div class="viz-card">
        <div class="viz-header">
          <span class="viz-title">💰 Cost & Credit Optimization Efficiency</span>
          <span id="savingsPctLabel" style="font-size:12px;font-weight:700;color:#2ecc71;">0% Optimized</span>
        </div>
        <div class="savings-track">
          <div class="savings-fill" id="savingsFill" style="width:0%;">0%</div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:10px;color:#64748b;">
          <span id="creditsUsedText">Used: 0.0 credits</span>
          <span id="creditsIfAllHeavyText">If unrouted: 0.0 credits</span>
        </div>
      </div>

      <div class="viz-card">
        <div class="viz-header">
          <span class="viz-title">📊 Tier Distribution</span>
        </div>
        <div class="tier-bars-grid">
          <div class="tier-item">
            <span class="tier-name" style="color:#2ecc71;">🟢 Light</span>
            <div class="tier-track"><div class="tier-fill-light" id="fillLight" style="width:0%;"></div></div>
            <span id="countLight" style="font-size:10px;font-weight:700;width:24px;text-align:right;">0</span>
          </div>
          <div class="tier-item">
            <span class="tier-name" style="color:#f59e0b;">🟡 Medium</span>
            <div class="tier-track"><div class="tier-fill-medium" id="fillMedium" style="width:0%;"></div></div>
            <span id="countMedium" style="font-size:10px;font-weight:700;width:24px;text-align:right;">0</span>
          </div>
          <div class="tier-item">
            <span class="tier-name" style="color:#ef4444;">🔴 Heavy</span>
            <div class="tier-track"><div class="tier-fill-heavy" id="fillHeavy" style="width:0%;"></div></div>
            <span id="countHeavy" style="font-size:10px;font-weight:700;width:24px;text-align:right;">0</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="table-container">
      <div class="table-header">
        <h2>📝 Live Routing Decision Log</h2>
        <button class="refresh" onclick="fetchMetrics()">↻ Refresh</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Prompt Snippet</th>
            <th>Task Type</th>
            <th>Score</th>
            <th>Signals (K/I/C/X/V)</th>
            <th>Routed Model</th>
            <th>Savings</th>
            <th>Why Selected</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          <tr><td colspan="8" class="empty-state">No requests yet. Send a prompt from your IDE!</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function explainChoice(m) {
      const score = (m.complexityScore !== undefined ? m.complexityScore : (m.score || 0)).toFixed(1);
      const tier = (m.tier || '').toLowerCase();
      if (tier.includes('light')) {
        return 'Score < 4.0 (simple lookup/explanation) → routed to light model to save credits.';
      } else if (tier.includes('medium')) {
        return 'Score 4.0–6.4 (code generation/refactoring) → balanced model for quality.';
      } else if (tier.includes('heavy')) {
        return 'Score >= 6.5 (complex architecture/agent tools) → heavy model for deep reasoning.';
      }
      return 'Bypassed internal Copilot utility task.';
    }

    async function fetchMetrics() {
      try {
        const res = await fetch('/metrics');
        const data = await res.json();

        const total = data.length;
        const tier2Items = data.filter(d => d.savings || (d.routedModel || d.model || '').includes('mini') || (d.complexityScore || d.score || 0) < 4.0);
        const tier2Count = tier2Items.length;
        const tier1Count = total - tier2Count;

        document.getElementById('totalRequests').textContent = total;
        document.getElementById('tier1Count').textContent = tier1Count;
        document.getElementById('tier2Count').textContent = tier2Count;

        const avg = total > 0 ? (data.reduce((s, d) => s + (d.complexityScore || d.score || 0), 0) / total).toFixed(1) : '0';
        document.getElementById('avgScore').textContent = avg;

        const dollars = (tier2Count * 0.014).toFixed(3);
        const credits = (tier2Count * 0.8).toFixed(1);
        document.getElementById('costSaved').textContent = \`$\${dollars}\`;
        document.getElementById('creditsSaved').textContent = credits;

        // Visualizer calculations
        const pct = total > 0 ? Math.round((tier2Count / total) * 100) : 0;
        document.getElementById('savingsPctLabel').textContent = pct + '% Optimized';
        const fillEl = document.getElementById('savingsFill');
        fillEl.style.width = Math.max(pct, 5) + '%';
        fillEl.textContent = pct + '%';
        document.getElementById('creditsUsedText').textContent = 'Used: ' + (tier1Count * 1.0 + tier2Count * 0.2).toFixed(1) + ' credits';
        document.getElementById('creditsIfAllHeavyText').textContent = 'If unrouted: ' + (total * 1.0).toFixed(1) + ' credits';

        // Tiers
        let light = 0, medium = 0, heavy = 0;
        data.forEach(d => {
          const t = (d.tier || '').toLowerCase();
          if (t.includes('light')) light++;
          else if (t.includes('medium')) medium++;
          else heavy++;
        });
        const maxTier = Math.max(light, medium, heavy, 1);
        document.getElementById('fillLight').style.width = ((light / maxTier) * 100) + '%';
        document.getElementById('fillMedium').style.width = ((medium / maxTier) * 100) + '%';
        document.getElementById('fillHeavy').style.width = ((heavy / maxTier) * 100) + '%';
        document.getElementById('countLight').textContent = light;
        document.getElementById('countMedium').textContent = medium;
        document.getElementById('countHeavy').textContent = heavy;

        const tbody = document.getElementById('tableBody');
        if (total === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No requests yet. Send a prompt from your IDE!</td></tr>';
          return;
        }

        tbody.innerHTML = data.slice(0, 30).map(d => {
          const scoreVal = d.complexityScore !== undefined ? d.complexityScore : (d.score || 0);
          const routedModelVal = (d.routedModel || d.model || '__auto__').split('/').pop();
          const promptVal = (d.prompt || d.promptSnippet || '—').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const isTier2 = d.savings || (routedModelVal.includes('mini') || scoreVal < 4.0);
          const tier = d.tier || (scoreVal >= 6.5 ? 'Heavy tier' : (scoreVal >= 4.0 ? 'Medium tier' : 'Light tier'));
          const tierClass = tier.toLowerCase().includes('heavy') ? 'pill-heavy' : (tier.toLowerCase().includes('medium') ? 'pill-medium' : 'pill-light');
          const s = d.signals || {};
          const why = explainChoice(d);

          return \`<tr>
            <td style="color:#64748b;white-space:nowrap;">\${formatTime(d.timestamp)}</td>
            <td><div class="prompt-snippet" title="\${promptVal}">\${promptVal}</div></td>
            <td><span class="pill pill-task">\${d.taskType || 'GENERAL'}</span></td>
            <td><strong>\${scoreVal.toFixed(1)}</strong></td>
            <td>
              <div class="signals">
                <span class="signal-dot" style="background:rgba(167,139,250,0.2);color:#c4b5fd" title="Keyword">\${s.keyword ?? '-'}</span>
                <span class="signal-dot" style="background:rgba(96,165,250,0.2);color:#93c5fd" title="Intent">\${s.intent ?? '-'}</span>
                <span class="signal-dot" style="background:rgba(134,239,172,0.2);color:#86efac" title="Code">\${s.code ?? '-'}</span>
                <span class="signal-dot" style="background:rgba(251,191,36,0.2);color:#fbbf24" title="Context">\${s.context ?? '-'}</span>
                <span class="signal-dot" style="background:rgba(236,72,153,0.2);color:#f472b6" title="Vector">\${s.vector ?? '-'}</span>
              </div>
            </td>
            <td><span class="pill \${tierClass}">\${routedModelVal}</span></td>
            <td><span class="pill \${isTier2 ? 'pill-saved' : 'pill-full'}">\${isTier2 ? '✅ Saved' : '⚡ Full'}</span></td>
            <td><div class="why-text">\${why}</div></td>
          </tr>\`;
        }).join('');
      } catch (e) {
        console.error('Fetch error:', e);
      }
    }

    fetchMetrics();
    setInterval(fetchMetrics, 3000);
  </script>
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  private recordMetric(record: MetricRecord): void {
    this.metrics.unshift(record);
    if (this.metrics.length > 200) {
      this.metrics.pop();
    }
    if (this.onMetricListener) {
      this.onMetricListener();
    }
  }
}
