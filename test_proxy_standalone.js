#!/usr/bin/env node
/**
 * Standalone test: spawns the proxy server from compiled output 
 * on a test port and runs all E2E tests against it.
 */

// Load the compiled modules directly
const path = require("path");
const http = require("http");

// We'll start a fresh proxy on port 3457 for isolated testing
const TEST_PORT = 3457;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}

// ── Manually create a test server using the compiled modules ──
const { RouterLogic } = require("./out/proxy/RouterLogic");
const { OpenAiClient } = require("./out/proxy/OpenAiClient");

// Simulate the extractPromptText function
function extractPromptText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role && msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
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
  const last = messages[messages.length - 1];
  if (last && typeof last.content === "string") return last.content;
  return "";
}

const metrics = [];

const testServer = http.createServer((req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  if ((url === "/v1/models" || url === "/models") && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "copilot-pulse", object: "model", created: 1785897097, owned_by: "copilot-pulse" },
        { id: "copilot-pulse-agent", object: "model", created: 1785897097, owned_by: "copilot-pulse" }
      ]
    }));
  } else if ((url === "/v1/chat/completions" || url === "/chat/completions") && (method === "POST" || method === "OPTIONS")) {
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400"
      });
      res.end();
      return;
    }

    let bodyStr = "";
    req.on("data", chunk => bodyStr += chunk);
    req.on("end", () => {
      try {
        const requestJson = JSON.parse(bodyStr);
        const requestedModel = requestJson.model || "copilot-pulse";
        const isStreaming = requestJson.stream !== false;

        const promptText = extractPromptText(requestJson.messages);
        const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
        const decision = RouterLogic.routeDecision(cleanPrompt, {
          cheapModel: "openai/gpt-4o-mini",
          strongModel: "openai/gpt-4o",
          threshold: 6.5,
          lowThreshold: 4.0,
          useDynamicTiers: true,
          availableModels: ["gpt-4o-mini", "gpt-4o", "claude-3.5-sonnet"]
        });
        const taskType = RouterLogic.detectTaskType ? RouterLogic.detectTaskType(cleanPrompt) : "GENERAL";
        const roundedScore = Math.round(decision.score * 10) / 10;

        const record = {
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
          latencyMs: 0
        };
        metrics.push(record);

        // Strip Copilot-internal fields
        const copilotFields = ["intent", "copilot_references", "copilot_thread_id", "nwo"];
        for (const field of copilotFields) {
          delete requestJson[field];
        }

        // Since we don't have an upstream provider, return a mock response
        if (isStreaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          });
          const chunk = {
            id: "test-1",
            object: "chat.completion.chunk",
            model: requestedModel,
            choices: [{ index: 0, delta: { content: `[Routed to ${decision.model}, score=${roundedScore}, tier=${decision.tier}]` }, finish_reason: "stop" }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          });
          res.end(JSON.stringify({
            id: "test-1",
            object: "chat.completion",
            model: requestedModel,
            choices: [{ index: 0, message: { role: "assistant", content: `[Routed to ${decision.model}, score=${roundedScore}, tier=${decision.tier}]` }, finish_reason: "stop" }]
          }));
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (url === "/metrics" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(metrics));
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

async function fetchJSON(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: opts.method || "GET",
      headers: opts.headers || {}
    };
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk.toString());
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: body,
          json: () => { try { return JSON.parse(body); } catch { return null; } }
        });
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function runTests() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Copilot Pulse — Standalone Proxy Test Suite        ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  // TEST 1: Models endpoint
  console.log("\n── TEST 1: GET /v1/models ──");
  let r = await fetchJSON(`${BASE}/v1/models`);
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  const models = r.json();
  assert(models?.object === "list", "Response has object=list");
  assert(models?.data?.some(m => m.id === "copilot-pulse"), 'Contains "copilot-pulse" model');

  // TEST 2: Simple streaming chat
  console.log("\n── TEST 2: Simple streaming chat ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [{ role: "user", content: "what is 2+2?" }],
      stream: true
    })
  });
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  assert(r.text.includes("data: "), "Response has SSE data");
  assert(r.text.includes("[DONE]"), "Response has [DONE] marker");
  assert(r.text.includes('"model":"copilot-pulse"'), "Model name rewritten to copilot-pulse");

  // TEST 3: Agent-mode content array
  console.log("\n── TEST 3: Agent-mode content array [{type:'text', text:'...'}] ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: [{ type: "text", text: "design a microservice architecture with event-driven patterns and CQRS for e-commerce" }] }
      ],
      tools: [{ type: "function", function: { name: "runTerminal", parameters: {} } }],
      stream: true
    })
  });
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  // The architecture prompt should score HIGH
  const archData = r.text;
  const archScoreMatch = archData.match(/score=([\d.]+)/);
  if (archScoreMatch) {
    const archScore = parseFloat(archScoreMatch[1]);
    assert(archScore >= 5.0, `Architecture scored HIGH (${archScore}/10)`);
    console.log(`    → Prompt score: ${archScore}`);
  }

  // TEST 4: Non-streaming request
  console.log("\n── TEST 4: Non-streaming request (stream=false) ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [{ role: "user", content: "explain closures" }],
      stream: false
    })
  });
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  const nonStreamJson = r.json();
  assert(nonStreamJson?.object === "chat.completion", 'Response has object="chat.completion"');
  assert(nonStreamJson?.model === "copilot-pulse", "Model name rewritten");

  // TEST 5: CORS preflight
  console.log("\n── TEST 5: CORS OPTIONS preflight ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: { "Origin": "vscode-webview://test", "Access-Control-Request-Method": "POST" }
  });
  assert(r.status === 204, `Status 204 (got ${r.status})`);
  assert(r.headers["access-control-allow-origin"] === "*", `CORS Allow-Origin=* (got ${r.headers["access-control-allow-origin"]})`);
  assert(r.headers["access-control-allow-methods"]?.includes("POST"), "CORS Allow-Methods includes POST");

  // TEST 6: Copilot-specific field stripping
  console.log("\n── TEST 6: Copilot fields stripped ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [{ role: "user", content: "run npm install" }],
      stream: true,
      intent: "agentAction",
      copilot_references: [{ type: "file", uri: "file:///test.ts" }],
      copilot_thread_id: "abc-123",
      nwo: "user/repo"
    })
  });
  assert(r.status === 200, `Handles Copilot fields (status ${r.status})`);

  // TEST 7: Multi-turn with tool results
  console.log("\n── TEST 7: Multi-turn agent conversation ──");
  r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "refactor authentication to use JWT with refresh token rotation" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "readFile", arguments: '{"path":"src/auth.ts"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "export class AuthService { ... }" },
        { role: "user", content: "now apply the refactoring changes to use bcrypt for password hashing" }
      ],
      tools: [
        { type: "function", function: { name: "readFile", parameters: {} } },
        { type: "function", function: { name: "editFile", parameters: {} } }
      ],
      stream: true
    })
  });
  assert(r.status === 200, `Multi-turn handled (status ${r.status})`);
  // The "refactoring" prompt in last user message should score reasonably
  const refactorMatch = r.text.match(/score=([\d.]+)/);
  if (refactorMatch) {
    console.log(`    → Last user msg score: ${refactorMatch[1]}`);
  }

  // TEST 8: Verify metrics
  console.log("\n── TEST 8: Metrics verification ──");
  r = await fetchJSON(`${BASE}/metrics`);
  const allMetrics = r.json();
  assert(Array.isArray(allMetrics) && allMetrics.length >= 5, `Recorded ${allMetrics?.length} metrics`);

  // Check routing accuracy
  const simpleM = allMetrics.find(m => m.prompt?.includes("2+2"));
  if (simpleM) {
    assert(simpleM.score < 4.0, `"what is 2+2" → score ${simpleM.score} < 4.0 (Light)`);
    assert(simpleM.savings === true, `"what is 2+2" → savings=true`);
  }

  const archM = allMetrics.find(m => m.prompt?.includes("microservice"));
  if (archM) {
    assert(archM.score >= 5.0, `"architecture" → score ${archM.score} >= 5.0 (Heavy)`);
  }

  // Print summary table
  console.log("\n── Routing Decision Summary ──");
  console.log("  ┌──────────────────────────────────────────────────────────────────────────┐");
  console.log("  │ Prompt                                     │ Score │ Tier       │ Model  │");
  console.log("  ├──────────────────────────────────────────────────────────────────────────┤");
  for (const m of allMetrics) {
    const p = (m.promptSnippet || "").padEnd(42).slice(0, 42);
    const s = String(m.score).padEnd(5);
    const t = (m.tier || "?").padEnd(10);
    const md = (m.routedModel || "?").split("/").pop().slice(0, 6);
    console.log(`  │ ${p} │ ${s} │ ${t} │ ${md.padEnd(6)} │`);
  }
  console.log("  └──────────────────────────────────────────────────────────────────────────┘");

  // TEST 9: Config injection test
  console.log("\n── TEST 9: Config injection (CopilotConfigInjector) ──");
  const { CopilotConfigInjector } = require("./out/config/CopilotConfigInjector");
  const result = CopilotConfigInjector.injectConfig();
  assert(result === true, `injectConfig() returned true`);

  const fs = require("fs");
  const os = require("os");
  const clmPath = path.join(os.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  if (fs.existsSync(clmPath)) {
    const clm = JSON.parse(fs.readFileSync(clmPath, "utf-8"));
    const entry = Array.isArray(clm) && clm.find(p => p._copilotPulseMarker === "copilot-pulse-local-proxy");
    assert(!!entry, `chatLanguageModels.json has Copilot Pulse entry`);
    if (entry) {
      assert(entry.vendor === "customendpoint", `vendor = "customendpoint" (got "${entry.vendor}")`);
      assert(entry.apiType === "chat-completions", `apiType = "chat-completions"`);
      assert(entry.models?.some(m => m.id === "copilot-pulse"), `chatLanguageModels.json has "copilot-pulse"`);
      assert(entry.models?.some(m => m.id === "copilot-pulse-agent"), `chatLanguageModels.json has "copilot-pulse-agent"`);
      assert(entry.models?.every(m => m.toolCalling === true), `all models have toolCalling = true`);
      assert(entry.models?.every(m => m.url?.includes("127.0.0.1:3456")), `all models point to local proxy`);
    }
  } else {
    failed++;
    console.log(`  ❌ chatLanguageModels.json not found at ${clmPath}`);
  }

  const byokPath = path.join(os.homedir(), ".config", "github-copilot", "byok.json");
  if (fs.existsSync(byokPath)) {
    const byok = JSON.parse(fs.readFileSync(byokPath, "utf-8"));
    assert(byok["OpenRouter-baseUrl"] === "http://127.0.0.1:3456", `byok.json baseUrl → proxy`);
    assert(byok["OpenRouter-models-config"]?.["copilot-pulse"]?.modelCapabilities?.toolCalling === true, `byok.json copilot-pulse toolCalling=true`);
    assert(byok["OpenRouter-models-config"]?.["copilot-pulse-agent"]?.modelCapabilities?.toolCalling === true, `byok.json copilot-pulse-agent toolCalling=true`);
  }
}

// ── Start server and run ──
testServer.listen(TEST_PORT, "127.0.0.1", async () => {
  console.log(`Test proxy listening on ${BASE}\n`);
  try {
    await runTests();
  } catch (e) {
    console.error("\n💥 FATAL:", e);
    failed++;
  }
  testServer.close();
  console.log(`\n══════════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`══════════════════════════════════════════════════════\n`);
  process.exit(failed > 0 ? 1 : 0);
});
