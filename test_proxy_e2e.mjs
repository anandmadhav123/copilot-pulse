#!/usr/bin/env node
/**
 * Copilot Pulse — End-to-end proxy integration tests.
 * Simulates the exact HTTP requests that VS Code Copilot Agent sends
 * through the BYOK custom endpoint to the local proxy.
 *
 * Run: node test_proxy_e2e.mjs
 */

const BASE = "http://127.0.0.1:3456";

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

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json: () => { try { return JSON.parse(text); } catch { return null; } } };
}

// ─────────────────────────────────────────────────────────
// TEST 1: /v1/models endpoint
// ─────────────────────────────────────────────────────────
async function testModelsEndpoint() {
  console.log("\n── TEST 1: GET /v1/models ──");
  const r = await fetchJSON(`${BASE}/v1/models`);
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  const j = r.json();
  assert(j && j.object === "list", `Response has object="list"`);
  assert(Array.isArray(j.data) && j.data.length >= 1, `Has at least 1 model (got ${j.data?.length})`);
  assert(j.data.some(m => m.id === "copilot-pulse"), `Contains "copilot-pulse" model`);
}

// ─────────────────────────────────────────────────────────
// TEST 2: Simple streaming chat (string content)
// ─────────────────────────────────────────────────────────
async function testSimpleStreamChat() {
  console.log("\n── TEST 2: POST /v1/chat/completions (stream, string content) ──");
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer copilot-pulse" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [{ role: "user", content: "what is 2+2?" }],
      stream: true
    })
  });
  // Without upstream API key, expect 401 — but routing should be recorded
  assert(r.status === 401 || r.status === 200, `Status 401 (no API key) or 200 (got ${r.status})`);
}

// ─────────────────────────────────────────────────────────
// TEST 3: Agent-mode content array [{type:"text", text:"..."}]
// ─────────────────────────────────────────────────────────
async function testAgentContentArray() {
  console.log("\n── TEST 3: POST /v1/chat/completions (agent-mode content array) ──");
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer copilot-pulse" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [
        { role: "system", content: "You are a coding assistant with access to tools." },
        { role: "user", content: [{ type: "text", text: "design a microservice architecture for an e-commerce platform with event-driven patterns and CQRS" }] }
      ],
      tools: [
        { type: "function", function: { name: "runTerminalCommand", parameters: { type: "object", properties: { command: { type: "string" } } } } },
        { type: "function", function: { name: "editFile", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } }
      ],
      stream: true
    })
  });
  assert(r.status === 401 || r.status === 200, `Status 401/200 (got ${r.status})`);
}

// ─────────────────────────────────────────────────────────
// TEST 4: Non-streaming request (stream=false)
// ─────────────────────────────────────────────────────────
async function testNonStreaming() {
  console.log("\n── TEST 4: POST /v1/chat/completions (stream=false) ──");
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer copilot-pulse" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [{ role: "user", content: "explain what a closure is in JavaScript" }],
      stream: false
    })
  });
  assert(r.status === 401 || r.status === 200, `Status 401/200 for non-stream (got ${r.status})`);
}

// ─────────────────────────────────────────────────────────
// TEST 5: CORS OPTIONS preflight
// ─────────────────────────────────────────────────────────
async function testCORSPreflight() {
  console.log("\n── TEST 5: OPTIONS /v1/chat/completions (CORS preflight) ──");
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "OPTIONS",
    headers: {
      "Origin": "vscode-webview://abcdef",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization"
    }
  });
  assert(r.status === 204, `Status 204 No Content (got ${r.status})`);
  assert(r.headers["access-control-allow-origin"] === "*", `CORS Allow-Origin=* (got ${r.headers["access-control-allow-origin"]})`);
  assert(r.headers["access-control-allow-methods"]?.includes("POST"), `CORS Allow-Methods includes POST`);
}

// ─────────────────────────────────────────────────────────
// TEST 6: Metrics endpoint — verify routing decisions
// ─────────────────────────────────────────────────────────
async function testMetrics() {
  console.log("\n── TEST 6: GET /metrics (verify routing decisions) ──");
  const r = await fetchJSON(`${BASE}/metrics`);
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  const metrics = r.json();
  assert(Array.isArray(metrics) && metrics.length > 0, `Has recorded metrics (count=${metrics?.length})`);

  // Find the architecture prompt — should score HIGH
  const archMetric = metrics.find(m => m.prompt?.includes("microservice") && m.prompt?.includes("architecture"));
  if (archMetric) {
    assert(archMetric.score >= 5, `Architecture prompt scored high (${archMetric.score}/10)`);
    assert(archMetric.tier?.toLowerCase().includes("heavy") || archMetric.tier?.toLowerCase().includes("medium"), `Routed to Heavy/Medium tier (got "${archMetric.tier}")`);
    console.log(`    → Score=${archMetric.score}, Tier="${archMetric.tier}", Model="${archMetric.routedModel}"`);
  } else {
    console.log("    ⚠️  Architecture metric not found (may be from a previous run)");
  }

  // Find the simple "2+2" prompt — should score LOW
  const simpleMetric = metrics.find(m => m.prompt?.includes("2+2"));
  if (simpleMetric) {
    assert(simpleMetric.score < 5, `Simple prompt scored low (${simpleMetric.score}/10)`);
    assert(simpleMetric.tier?.toLowerCase().includes("light"), `Routed to Light tier (got "${simpleMetric.tier}")`);
    console.log(`    → Score=${simpleMetric.score}, Tier="${simpleMetric.tier}", Model="${simpleMetric.routedModel}"`);
  } else {
    console.log("    ⚠️  Simple metric not found");
  }

  // Find the closure explanation — should score MEDIUM
  const closureMetric = metrics.find(m => m.prompt?.includes("closure"));
  if (closureMetric) {
    console.log(`    → Closure: Score=${closureMetric.score}, Tier="${closureMetric.tier}", Model="${closureMetric.routedModel}"`);
  }
}

// ─────────────────────────────────────────────────────────
// TEST 7: Tool-call request with Copilot-specific fields
// ─────────────────────────────────────────────────────────
async function testCopilotFieldStripping() {
  console.log("\n── TEST 7: Copilot-specific fields stripped ──");
  // We can't inspect what goes upstream, but we verify the proxy doesn't crash
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer copilot-pulse" },
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
  assert(r.status === 401 || r.status === 200, `Handles Copilot fields gracefully (status ${r.status})`);
}

// ─────────────────────────────────────────────────────────
// TEST 8: Multi-turn conversation with tool results
// ─────────────────────────────────────────────────────────
async function testMultiTurnWithToolResults() {
  console.log("\n── TEST 8: Multi-turn with tool results (agent pattern) ──");
  const r = await fetchJSON(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer copilot-pulse" },
    body: JSON.stringify({
      model: "copilot-pulse",
      messages: [
        { role: "system", content: "You are a helpful coding assistant." },
        { role: "user", content: "refactor the authentication module to use JWT tokens and implement refresh token rotation" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "readFile", arguments: '{"path":"src/auth.ts"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "export class AuthService { ... }" },
        { role: "user", content: "now apply the changes" }
      ],
      tools: [
        { type: "function", function: { name: "readFile", parameters: { type: "object", properties: { path: { type: "string" } } } } },
        { type: "function", function: { name: "editFile", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } }
      ],
      stream: true
    })
  });
  assert(r.status === 401 || r.status === 200, `Multi-turn agent request handled (status ${r.status})`);
}

// ─────────────────────────────────────────────────────────
// TEST 9: Dashboard endpoint
// ─────────────────────────────────────────────────────────
async function testDashboard() {
  console.log("\n── TEST 9: GET /dashboard ──");
  const r = await fetchJSON(`${BASE}/dashboard`);
  assert(r.status === 200, `Status 200 (got ${r.status})`);
  assert(r.text.includes("Copilot Pulse Dashboard"), `Contains dashboard HTML`);
  assert(r.text.includes("fetchMetrics"), `Contains JS fetch logic`);
}

// ─────────────────────────────────────────────────────────
// TEST 10: Config injection verification
// ─────────────────────────────────────────────────────────
async function testConfigFiles() {
  console.log("\n── TEST 10: Config file verification ──");
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");

  // Check chatLanguageModels.json
  const clmPath = path.join(os.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  const clmExists = fs.existsSync(clmPath);
  console.log(`  chatLanguageModels.json path: ${clmPath}`);
  if (clmExists) {
    const clm = JSON.parse(fs.readFileSync(clmPath, "utf-8"));
    const pulseEntry = Array.isArray(clm) && clm.find(p => p._copilotPulseMarker === "copilot-pulse-local-proxy");
    assert(!!pulseEntry, `chatLanguageModels.json has Copilot Pulse entry`);
    if (pulseEntry) {
      assert(pulseEntry.vendor === "customendpoint", `vendor = "customendpoint"`);
      assert(pulseEntry.apiType === "chat-completions", `apiType = "chat-completions"`);
      const model = pulseEntry.models?.[0];
      assert(model?.toolCalling === true, `toolCalling = true`);
      assert(model?.url?.includes("127.0.0.1:3456"), `URL points to local proxy`);
      assert(model?.name?.includes("Smart Router"), `Model name is "Copilot Pulse (Smart Router)"`);
      console.log(`    → Entry: ${JSON.stringify(pulseEntry, null, 2).split("\n").slice(0, 8).join("\n")}...`);
    }
  } else {
    console.log(`  ⚠️  chatLanguageModels.json not found (will be created on extension activation)`);
  }

  // Check byok.json
  const byokPath = path.join(os.homedir(), ".config", "github-copilot", "byok.json");
  const byokExists = fs.existsSync(byokPath);
  if (byokExists) {
    const byok = JSON.parse(fs.readFileSync(byokPath, "utf-8"));
    assert(byok["OpenRouter-baseUrl"] === "http://127.0.0.1:3456", `byok.json baseUrl points to proxy`);
    assert(byok["OpenRouter-api-key"] === "copilot-pulse", `byok.json has copilot-pulse key`);
    const mc = byok["OpenRouter-models-config"]?.["copilot-pulse"];
    assert(mc?.modelCapabilities?.toolCalling === true, `byok.json model has toolCalling=true`);
    console.log(`    ✅ byok.json verified`);
  } else {
    console.log(`  ⚠️  byok.json not found`);
  }
}

// ─────────────────────────────────────────────────────────
// RUN ALL TESTS
// ─────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Copilot Pulse — BYOK Proxy E2E Test Suite          ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  try {
    await testModelsEndpoint();
    await testSimpleStreamChat();
    await testAgentContentArray();
    await testNonStreaming();
    await testCORSPreflight();
    await testCopilotFieldStripping();
    await testMultiTurnWithToolResults();
    await testDashboard();
    await testMetrics();
    await testConfigFiles();
  } catch (e) {
    console.error("\n💥 FATAL:", e.message);
    if (e.message?.includes("ECONNREFUSED")) {
      console.error("   The proxy server is not running. Make sure the extension is active in VS Code.");
    }
    failed++;
  }

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("══════════════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main();
