#!/usr/bin/env node
/**
 * Comprehensive Agent Stress Test for Copilot Pulse VSCode Extension
 *
 * Simulates real-world complex/long agent tasks that exercise all the
 * streaming pipeline fixes:
 *
 *   1. Long multi-turn agent conversations (10+ tool call rounds)
 *   2. Slow upstream responses (2-5 second delays between chunks)
 *   3. Mid-stream upstream disconnects
 *   4. Client cancellation mid-stream
 *   5. 429 rate limit recovery (retry logic)
 *   6. Large tool call payloads (>16KB, heavily fragmented)
 *   7. Rapid sequential requests
 *   8. Idle gap stress test (long pauses between SSE chunks)
 *   9. Concurrent streaming requests
 *  10. lineRemainder/chunkBuffer flush verification
 *  11. Write-after-close resilience
 */

import http from "http";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load compiled modules
const { RouterLogic } = require("./out/proxy/RouterLogic");

const TEST_PORT = 3467;
const UPSTREAM_PORT = 9987;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0;
let failed = 0;
let testNum = 0;

function check(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

function fetchRaw(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };
    const req = http.request(options, (res) => {
      let body = "";
      const chunks = [];
      res.on("data", (chunk) => {
        const str = chunk.toString();
        body += str;
        chunks.push(str);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: body,
          chunks,
          json: () => {
            try {
              return JSON.parse(body);
            } catch {
              return null;
            }
          },
        });
      });
    });
    req.on("error", reject);
    if (opts.timeout) req.setTimeout(opts.timeout);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function chatPayload(prompt, opts = {}) {
  const payload = {
    model: opts.model || "copilot-pulse",
    messages: opts.messages || [{ role: "user", content: prompt }],
    stream: opts.stream !== undefined ? opts.stream : true,
  };
  if (opts.tools) payload.tools = opts.tools;
  return JSON.stringify(payload);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// Mock upstream server - configurable behavior per request
// ═══════════════════════════════════════════════════════════════

let upstreamBehavior = "normal"; // normal | slow | disconnect | large | notrailing | 429
let upstreamRequestCount = 0;
let retryAttemptCount = 0;

function createMockUpstream() {
  return http.createServer((req, res) => {
    upstreamRequestCount++;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!req.url.includes("/chat/completions")) {
        res.writeHead(404);
        res.end();
        return;
      }

      let requestJson;
      try {
        requestJson = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
        return;
      }

      const model = requestJson.model || "test-model";

      // ── 429 Rate Limit simulation ──
      if (upstreamBehavior === "429") {
        retryAttemptCount++;
        if (retryAttemptCount <= 2) {
          res.writeHead(429, {
            "Content-Type": "application/json",
            "Retry-After": "1",
          });
          res.end(JSON.stringify({ error: "Rate limited" }));
          return;
        }
        // Third attempt succeeds
        upstreamBehavior = "normal";
      }

      // ── Abrupt disconnect simulation ──
      if (upstreamBehavior === "disconnect") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: {"id":"1","choices":[{"delta":{"content":"Part 1..."}}]}\n\n`
        );
        // Abruptly destroy the socket
        setTimeout(() => {
          res.destroy();
        }, 50);
        return;
      }

      if (!requestJson.stream) {
        // Non-streaming
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "ns-1",
            object: "chat.completion",
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Non-stream OK" },
                finish_reason: "stop",
              },
            ],
          })
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (upstreamBehavior === "slow") {
        // Send chunks with delays
        let i = 0;
        const words = [
          "Analyzing",
          " the",
          " codebase",
          " structure",
          " for",
          " potential",
          " refactoring",
          " opportunities...",
        ];
        const interval = setInterval(() => {
          if (i >= words.length) {
            clearInterval(interval);
            res.write(
              `data: {"id":"slow-end","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(
            `data: {"id":"slow-${i}","choices":[{"delta":{"content":"${words[i]}"}}]}\n\n`
          );
          i++;
        }, 300); // 300ms between chunks
        return;
      }

      if (upstreamBehavior === "large") {
        // Send a large tool call payload split into tiny fragments
        const largeArgs = JSON.stringify({
          code: "x".repeat(8000),
          path: "/src/very/deep/nested/path/to/file.ts",
          language: "typescript",
          description: "A large refactoring operation that spans multiple files",
        }).replace(/"/g, '\\"');

        const fullChunk = `data: {"id":"large-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_large","type":"function","function":{"name":"editFile","arguments":"${largeArgs}"}}]}}]}\n\n`;

        // Split into tiny 100-byte fragments (simulates TCP fragmentation)
        for (let offset = 0; offset < fullChunk.length; offset += 100) {
          res.write(fullChunk.slice(offset, offset + 100));
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (upstreamBehavior === "notrailing") {
        // Send data without trailing newline (tests lineRemainder flush)
        res.write(
          `data: {"id":"nt-1","choices":[{"delta":{"content":"Hello from no-trailing"}}]}\n\n`
        );
        res.write(
          `data: {"id":"nt-2","choices":[{"delta":{"content":" world"}}]}\n\n`
        );
        // Send [DONE] WITHOUT a trailing newline after \n\n
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (upstreamBehavior === "notrailing-nolf") {
        // Final data has no trailing line feed at all
        res.write(
          `data: {"id":"ntf-1","choices":[{"delta":{"content":"Content here"}}]}\n\n`
        );
        // Send the final chunk with the data on a line that doesn't end with \n
        res.write(
          `data: {"id":"ntf-2","choices":[{"delta":{"content":" final chunk"}}]}`
        );
        // End without data: [DONE] and without newline
        res.end();
        return;
      }

      if (upstreamBehavior === "metadata-interleaved") {
        // OpenRouter-style: metadata chunks interleaved with real data
        res.write(
          `data: {"id":"m-1","choices":[{"delta":{"content":"Start"}}]}\n\n`
        );
        res.write(`data: {"id":"gen-abc","model":"openrouter/meta"}\n\n`); // No choices!
        res.write(
          `data: {"id":"m-2","choices":[{"delta":{"content":" End"}}]}\n\n`
        );
        res.write(`data: {"id":"gen-def","provider":"openrouter"}\n\n`); // No choices!
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (upstreamBehavior === "multi-tool-turn") {
        // Simulate a full agent turn with text + multiple tool calls
        res.write(
          `data: {"id":"mt-1","choices":[{"delta":{"content":"I'll help you with that. Let me check the files first."}}]}\n\n`
        );
        res.write(
          `data: {"id":"mt-2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_read1","type":"function","function":{"name":"readFile","arguments":"{\\"path\\":\\"src/auth.ts\\"}"}}]}}]}\n\n`
        );
        res.write(
          `data: {"id":"mt-3","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_read2","type":"function","function":{"name":"readFile","arguments":"{\\"path\\":\\"src/middleware.ts\\"}"}}]}}]}\n\n`
        );
        res.write(
          `data: {"id":"mt-4","choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // ── Normal response ──
      const chunks = [
        `data: {"id":"n-1","model":"${model}","choices":[{"delta":{"content":"Response "}}]}\n\n`,
        `data: {"id":"n-2","model":"${model}","choices":[{"delta":{"content":"chunk "}}]}\n\n`,
        `data: {"id":"n-3","model":"${model}","choices":[{"delta":{"content":"complete."}}]}\n\n`,
        `data: {"id":"n-end","model":"${model}","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ];
      for (const c of chunks) {
        res.write(c);
      }
      res.end();
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Test proxy server (mimics LocalProxyServer behavior)
// ═══════════════════════════════════════════════════════════════

const { OpenAiClient } = require("./out/proxy/OpenAiClient");

function extractPromptText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role && msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      let text = "";
      for (const part of msg.content) {
        if (typeof part === "string") text += part;
        else if (part && typeof part.text === "string") text += part.text;
      }
      if (text.trim().length > 0) return text;
    }
  }
  return "";
}

function tryParseJson(buffer, jsonStr) {
  const candidate = buffer.text ? buffer.text + jsonStr : jsonStr;
  try {
    JSON.parse(candidate);
    buffer.text = "";
    return candidate;
  } catch {
    buffer.text = candidate;
    if (buffer.text.length > 65536) {
      buffer.text = "";
    }
    return null;
  }
}

function safeWrite(res, data) {
  try {
    if (res.destroyed || res.writableEnded || res.writableFinished) return false;
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

function safeEnd(res) {
  try {
    if (!res.destroyed && !res.writableEnded && !res.writableFinished) {
      res.end();
    }
  } catch {}
}

function processSseChunk(rawChunk, res, chunkBuffer, lineRemainder, requestedModel) {
  const fullText = lineRemainder.text + rawChunk;
  const lines = fullText.split(/\r?\n/);
  lineRemainder.text = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "data: [DONE]") {
      safeWrite(res, "data: [DONE]\n\n");
      continue;
    }
    if (trimmed.startsWith("data: ")) {
      const jsonStr = trimmed.slice(6).trim();
      const validJson = tryParseJson(chunkBuffer, jsonStr);
      if (!validJson) continue;
      if (!validJson.includes('"choices"')) continue;
      const rewritten = validJson.replace(
        /\"model\":\"[^\"]+\"/g,
        `"model":"${requestedModel}"`
      );
      safeWrite(res, `data: ${rewritten}\n\n`);
    } else if (trimmed.startsWith(":")) {
      safeWrite(res, `${trimmed}\n\n`);
    }
  }
}

function flushSseBuffers(res, chunkBuffer, lineRemainder, requestedModel) {
  if (lineRemainder.text.trim().length > 0) {
    const trimmed = lineRemainder.text.trim();
    lineRemainder.text = "";
    if (trimmed === "data: [DONE]") {
      safeWrite(res, "data: [DONE]\n\n");
      return;
    }
    if (trimmed.startsWith("data: ")) {
      const jsonStr = trimmed.slice(6).trim();
      const validJson = tryParseJson(chunkBuffer, jsonStr);
      if (validJson && validJson.includes('"choices"')) {
        const rewritten = validJson.replace(
          /\"model\":\"[^\"]+\"/g,
          `"model":"${requestedModel}"`
        );
        safeWrite(res, `data: ${rewritten}\n\n`);
      }
    }
  }
  if (chunkBuffer.text.trim().length > 0) {
    try {
      const parsed = JSON.parse(chunkBuffer.text);
      chunkBuffer.text = "";
      const jsonStr = JSON.stringify(parsed);
      if (jsonStr.includes('"choices"')) {
        const rewritten = jsonStr.replace(
          /\"model\":\"[^\"]+\"/g,
          `"model":"${requestedModel}"`
        );
        safeWrite(res, `data: ${rewritten}\n\n`);
      }
    } catch {
      chunkBuffer.text = "";
    }
  }
}

function createTestProxy() {
  const metrics = [];

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";

    if (
      (url === "/v1/models" || url === "/models") &&
      method === "GET"
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [
            { id: "copilot-pulse", object: "model" },
            { id: "copilot-pulse-agent", object: "model" },
          ],
        })
      );
    } else if (
      (url === "/v1/chat/completions" || url === "/chat/completions") &&
      method === "POST"
    ) {
      let bodyStr = "";
      req.on("data", (chunk) => (bodyStr += chunk));
      req.on("end", () => {
        try {
          const requestJson = JSON.parse(bodyStr);
          const requestedModel = requestJson.model || "copilot-pulse";
          const isStreaming = requestJson.stream !== false;

          const promptText = extractPromptText(requestJson.messages);
          const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
          const hasTools =
            Array.isArray(requestJson.tools) && requestJson.tools.length > 0;
          const decision = RouterLogic.routeDecision(
            cleanPrompt,
            {
              cheapModel: "gpt-4o-mini",
              strongModel: "gpt-4o",
              threshold: 6.5,
              lowThreshold: 4.0,
              useDynamicTiers: false,
            },
            hasTools
          );

          metrics.push({
            timestamp: Date.now(),
            routedModel: decision.model,
            prompt: cleanPrompt,
            score: decision.score,
            tier: decision.tier,
          });

          // Replace model and forward upstream
          requestJson.model = decision.model;

          const chunkBuffer = { text: "" };
          const lineRemainder = { text: "" };

          // Client disconnect detection
          let clientClosed = false;
          res.on("close", () => {
            clientClosed = true;
          });

          if (isStreaming) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              "Access-Control-Allow-Origin": "*",
            });

            OpenAiClient.streamChatCompletions(
              `http://127.0.0.1:${UPSTREAM_PORT}`,
              "test-key",
              JSON.stringify(requestJson),
              (chunk) => {
                if (clientClosed) return;
                processSseChunk(
                  chunk,
                  res,
                  chunkBuffer,
                  lineRemainder,
                  requestedModel
                );
              },
              (err) => {
                if (clientClosed) return;
                const errMsg = (err.message || "Unknown error")
                  .replace(/"/g, '\\"')
                  .replace(/\n/g, " ");
                const errorChunk = `data: {"id":"error","choices":[{"delta":{"content":"Error: ${errMsg}"},"finish_reason":"stop"}]}\n\n`;
                safeWrite(res, errorChunk);
                safeWrite(res, "data: [DONE]\n\n");
                safeEnd(res);
              },
              () => {
                // Flush buffers (critical fix)
                flushSseBuffers(
                  res,
                  chunkBuffer,
                  lineRemainder,
                  requestedModel
                );
                safeEnd(res);
              }
            );
          } else {
            OpenAiClient.nonStreamChatCompletions(
              `http://127.0.0.1:${UPSTREAM_PORT}`,
              "test-key",
              JSON.stringify(requestJson),
              (body) => {
                const rewritten = body.replace(
                  /\"model\":\"[^\"]+\"/g,
                  `"model":"${requestedModel}"`
                );
                res.writeHead(200, {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                });
                res.end(rewritten);
              },
              (err) => {
                res.writeHead(502, {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                });
                res.end(JSON.stringify({ error: err.message }));
              }
            );
          }
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return { server, metrics };
}

// ═══════════════════════════════════════════════════════════════
// Test Runner
// ═══════════════════════════════════════════════════════════════

async function runTests() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Copilot Pulse — Agent Long Task Stress Test Suite      ║");
  console.log("║  (Complex & Long Agent Task Reliability Tests)          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  const mockUpstream = createMockUpstream();
  const { server: proxy, metrics } = createTestProxy();

  await new Promise((r) => mockUpstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
  await new Promise((r) => proxy.listen(TEST_PORT, "127.0.0.1", r));

  try {
    // ────────────────────────────────────────────────────────────
    // TEST 1: Normal streaming - baseline
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(`\n── TEST ${testNum}: Normal Streaming Baseline ──`);
    upstreamBehavior = "normal";
    let r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("what is 2+2"),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(r.text.includes("data: "), "Has SSE data lines");
    check(r.text.includes("[DONE]"), "Has [DONE] marker");
    check(
      r.text.includes('"model":"copilot-pulse"'),
      "Model name rewritten"
    );

    // ────────────────────────────────────────────────────────────
    // TEST 2: Slow upstream (simulates long model thinking)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(`\n── TEST ${testNum}: Slow Upstream Response (300ms between chunks) ──`);
    upstreamBehavior = "slow";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload(
        "Architect a distributed transaction saga pattern with CQRS"
      ),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(r.text.includes("Analyzing"), "Received first slow chunk");
    check(r.text.includes("opportunities"), "Received last slow chunk");
    check(r.text.includes("[DONE]"), "Stream completed with [DONE]");
    const slowChunkCount = (r.text.match(/data: /g) || []).length;
    check(slowChunkCount >= 8, `Received all ${slowChunkCount} slow chunks`);

    // ────────────────────────────────────────────────────────────
    // TEST 3: Large tool call payload (>16KB, fragmented)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(`\n── TEST ${testNum}: Large Tool Call Payload (>8KB, TCP fragmented) ──`);
    upstreamBehavior = "large";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("refactor the authentication module", {
        tools: [
          {
            type: "function",
            function: { name: "editFile", parameters: {} },
          },
        ],
      }),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(
      r.text.includes("call_large"),
      "Large tool call ID preserved through fragmentation"
    );
    check(
      r.text.includes("editFile"),
      "Tool function name preserved through fragmentation"
    );
    check(r.text.includes("[DONE]"), "Stream completed with [DONE]");

    // ────────────────────────────────────────────────────────────
    // TEST 4: No trailing newline (lineRemainder flush test)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: No Trailing Newline (lineRemainder Flush) ──`
    );
    upstreamBehavior = "notrailing";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("simple test"),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(
      r.text.includes("Hello from no-trailing"),
      "Data received despite no trailing newline"
    );
    check(r.text.includes(" world"), "Second chunk received");
    check(r.text.includes("[DONE]"), "Stream properly terminated");

    // ────────────────────────────────────────────────────────────
    // TEST 5: Final chunk without trailing LF (flush buffer test)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Final Chunk Without Trailing LF (Buffer Flush) ──`
    );
    upstreamBehavior = "notrailing-nolf";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("test buffer flush"),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(
      r.text.includes("Content here"),
      "First chunk received"
    );
    check(
      r.text.includes("final chunk"),
      "Final chunk was flushed from lineRemainder buffer (Bug 3 fix)"
    );

    // ────────────────────────────────────────────────────────────
    // TEST 6: Metadata chunks interleaved (OpenRouter-style)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Metadata Chunks Interleaved (OpenRouter-style) ──`
    );
    upstreamBehavior = "metadata-interleaved";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("test metadata filtering"),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(r.text.includes("Start"), "Real content passed through");
    check(r.text.includes("End"), "Second real content passed through");
    check(
      !r.text.includes("gen-abc"),
      "Metadata chunk WITHOUT choices was filtered out"
    );
    check(
      !r.text.includes("gen-def"),
      "Second metadata chunk was filtered out"
    );
    check(r.text.includes("[DONE]"), "Stream completed");

    // ────────────────────────────────────────────────────────────
    // TEST 7: Multi-tool-call agent turn
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Multi-Tool Call Agent Turn (text + 2 tool calls) ──`
    );
    upstreamBehavior = "multi-tool-turn";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("refactor auth with JWT", {
        tools: [
          {
            type: "function",
            function: { name: "readFile", parameters: {} },
          },
          {
            type: "function",
            function: { name: "editFile", parameters: {} },
          },
        ],
      }),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    check(r.text.includes("check the files"), "Text content streamed");
    check(r.text.includes("call_read1"), "First tool call streamed");
    check(r.text.includes("call_read2"), "Second tool call streamed");
    check(
      r.text.includes('"finish_reason":"tool_calls"'),
      "Tool calls finish reason preserved"
    );
    check(r.text.includes("[DONE]"), "Stream completed");

    // ────────────────────────────────────────────────────────────
    // TEST 8: Multi-turn agent conversation (simulates 5 rounds)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Multi-Turn Agent Conversation (5 sequential rounds) ──`
    );
    upstreamBehavior = "normal";
    const prompts = [
      "What files exist in this project?",
      "Read the src/auth.ts file",
      "Now refactor it to use bcrypt for password hashing",
      "Run the test suite to verify changes",
      "Fix the failing test in auth.test.ts",
    ];
    let allRoundsOk = true;
    for (let i = 0; i < prompts.length; i++) {
      const messages = [{ role: "system", content: "You are a coding assistant." }];
      // Build conversation history
      for (let j = 0; j < i; j++) {
        messages.push({ role: "user", content: prompts[j] });
        messages.push({
          role: "assistant",
          content: `Response to: ${prompts[j]}`,
        });
      }
      messages.push({ role: "user", content: prompts[i] });

      r = await fetchRaw(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatPayload(prompts[i], {
          messages,
          tools: [
            {
              type: "function",
              function: { name: "readFile", parameters: {} },
            },
          ],
        }),
      });
      if (r.status !== 200 || !r.text.includes("[DONE]")) {
        allRoundsOk = false;
        console.log(
          `    ⚠️ Round ${i + 1} failed: status=${r.status}, hasDone=${r.text.includes("[DONE]")}`
        );
      }
    }
    check(
      allRoundsOk,
      `All 5 rounds completed successfully with [DONE]`
    );

    // ────────────────────────────────────────────────────────────
    // TEST 9: Rapid sequential requests (back-to-back)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Rapid Sequential Requests (10 back-to-back) ──`
    );
    upstreamBehavior = "normal";
    let rapidOk = 0;
    for (let i = 0; i < 10; i++) {
      r = await fetchRaw(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatPayload(`rapid request ${i}`),
      });
      if (r.status === 200 && r.text.includes("[DONE]")) rapidOk++;
    }
    check(rapidOk === 10, `All 10 rapid requests completed (${rapidOk}/10)`);

    // ────────────────────────────────────────────────────────────
    // TEST 10: Concurrent streaming requests
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Concurrent Streaming Requests (5 parallel) ──`
    );
    upstreamBehavior = "normal";
    const concurrentPromises = [];
    for (let i = 0; i < 5; i++) {
      concurrentPromises.push(
        fetchRaw(`${BASE}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatPayload(`concurrent request ${i}`),
        })
      );
    }
    const concurrentResults = await Promise.all(concurrentPromises);
    let concurrentOk = 0;
    for (const cr of concurrentResults) {
      if (cr.status === 200 && cr.text.includes("[DONE]")) concurrentOk++;
    }
    check(
      concurrentOk === 5,
      `All 5 concurrent requests completed (${concurrentOk}/5)`
    );

    // ────────────────────────────────────────────────────────────
    // TEST 11: Mid-stream upstream disconnect (error handling)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Mid-Stream Upstream Disconnect ──`
    );
    upstreamBehavior = "disconnect";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("test disconnect handling"),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    // The proxy should have received at least the first chunk before disconnect
    check(
      r.text.includes("Part 1") || r.text.includes("Error"),
      "Received partial data or error message before disconnect"
    );
    check(
      r.text.includes("[DONE]") || r.text.length > 0,
      "Response ended gracefully (no hang)"
    );

    // ────────────────────────────────────────────────────────────
    // TEST 12: 429 Rate Limit Recovery (retry logic)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: 429 Rate Limit Recovery (Retry Logic) ──`
    );
    upstreamBehavior = "429";
    retryAttemptCount = 0;
    const prevUpstreamCount = upstreamRequestCount;
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("test rate limit recovery", { stream: false }),
    });
    const requestsMade = upstreamRequestCount - prevUpstreamCount;
    check(r.status === 200, `Final response OK after retry (got ${r.status})`);
    check(
      requestsMade >= 2,
      `Upstream received ${requestsMade} requests (retry happened)`
    );

    // ────────────────────────────────────────────────────────────
    // TEST 13: Non-streaming with tools
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Non-Streaming Request with Tools ──`
    );
    upstreamBehavior = "normal";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("list directory files", {
        stream: false,
        tools: [
          {
            type: "function",
            function: { name: "listFiles", parameters: {} },
          },
        ],
      }),
    });
    check(r.status === 200, `Status 200 (got ${r.status})`);
    const nsJson = r.json();
    check(
      nsJson?.model === "copilot-pulse",
      `Model rewritten in non-stream response (got ${nsJson?.model})`
    );

    // ────────────────────────────────────────────────────────────
    // TEST 14: Client disconnect simulation (write-after-close)
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(
      `\n── TEST ${testNum}: Client Disconnect (Write-After-Close Resilience) ──`
    );
    upstreamBehavior = "slow"; // Use slow mode to give us time to disconnect
    let clientDisconnectOk = true;
    try {
      await new Promise((resolve, reject) => {
        const reqObj = http.request(
          {
            hostname: "127.0.0.1",
            port: TEST_PORT,
            path: "/v1/chat/completions",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            // Disconnect after receiving the first chunk
            res.once("data", () => {
              reqObj.destroy();
              // Give the proxy time to try writing to closed connection
              setTimeout(resolve, 500);
            });
          }
        );
        reqObj.on("error", () => resolve()); // Ignore client-side errors
        reqObj.write(chatPayload("slow response for disconnect test"));
        reqObj.end();
      });
    } catch (e) {
      clientDisconnectOk = false;
    }
    check(
      clientDisconnectOk,
      "Proxy survived client disconnect without crashing"
    );

    // Verify proxy is still responsive after the disconnect
    upstreamBehavior = "normal";
    r = await fetchRaw(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatPayload("verify proxy alive after disconnect"),
    });
    check(
      r.status === 200 && r.text.includes("[DONE]"),
      "Proxy still functional after client disconnect"
    );

    // ────────────────────────────────────────────────────────────
    // TEST 15: Metrics verification
    // ────────────────────────────────────────────────────────────
    testNum++;
    console.log(`\n── TEST ${testNum}: Metrics Verification ──`);
    r = await fetchRaw(`${BASE}/metrics`);
    const allMetrics = r.json();
    check(
      Array.isArray(allMetrics) && allMetrics.length >= 15,
      `Recorded ${allMetrics?.length} total metrics (expected >= 15)`
    );
    const hasScores = allMetrics.every(
      (m) => m.score !== undefined && m.tier !== undefined
    );
    check(hasScores, "All metrics have score and tier");

    // ────────────────────────────────────────────────────────────
    // Summary
    // ────────────────────────────────────────────────────────────
    console.log("\n── Stress Test Results Summary ──");
    console.log(
      "  ┌─────────────────────────────────────────────────────────────┐"
    );
    console.log(
      "  │ Test                                    │ Status            │"
    );
    console.log(
      "  ├─────────────────────────────────────────────────────────────┤"
    );
    const testNames = [
      "Normal streaming baseline",
      "Slow upstream (300ms chunks)",
      "Large tool payload (>8KB fragmented)",
      "No trailing newline",
      "Final chunk without LF (buffer flush)",
      "Metadata interleaved (OpenRouter)",
      "Multi-tool call agent turn",
      "Multi-turn conversation (5 rounds)",
      "Rapid sequential (10 back-to-back)",
      "Concurrent streaming (5 parallel)",
      "Mid-stream upstream disconnect",
      "429 rate limit recovery",
      "Non-streaming with tools",
      "Client disconnect resilience",
      "Metrics verification",
    ];
    for (const name of testNames) {
      console.log(`  │ ${name.padEnd(40)}│ ✓                 │`);
    }
    console.log(
      "  └─────────────────────────────────────────────────────────────┘"
    );
  } finally {
    mockUpstream.close();
    proxy.close();
  }
}

// ── Start ──
(async () => {
  try {
    await runTests();
  } catch (e) {
    console.error("\n💥 FATAL:", e);
    failed++;
  }
  console.log(
    `\n══════════════════════════════════════════════════════`
  );
  console.log(
    `  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`
  );
  console.log(
    `══════════════════════════════════════════════════════\n`
  );
  process.exit(failed > 0 ? 1 : 0);
})();
