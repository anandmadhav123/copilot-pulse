#!/usr/bin/env node
import Module from "module";

// Mock vscode module for standalone node testing
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === "vscode") {
    return {
      workspace: {
        getConfiguration: () => ({
          get: (k) => undefined,
          inspect: () => ({ globalValue: true }),
          update: async () => {}
        })
      },
      window: {
        createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
        createStatusBarItem: () => ({ show: () => {}, text: "", tooltip: "", command: "" }),
        showInformationMessage: () => {},
        showErrorMessage: () => {}
      },
      lm: {
        selectChatModels: async () => [],
        tools: [
          { name: "runTerminalCommand", description: "Run terminal command in workspace" },
          { name: "editFile", description: "Edit file in workspace" }
        ],
        invokeTool: async (name, opts) => ({
          content: [{ value: `Mock execution of tool: ${name} with input: ${JSON.stringify(opts.input)}` }]
        })
      },
      chat: {
        createChatParticipant: (id, handler) => ({ id, handler, iconPath: {} })
      },
      ThemeIcon: class {},
      LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
      LanguageModelChatMessage: class {
        constructor(role, content) {
          this.role = role;
          this.content = content;
        }
        static User(text) { return { role: 1, content: text }; }
        static Assistant(text) { return { role: 2, content: text }; }
      },
      LanguageModelTextPart: class {
        constructor(value) { this.value = value; }
      },
      LanguageModelToolCallPart: class {
        constructor(name, input, callId) {
          this.name = name;
          this.input = input;
          this.callId = callId || "call_123";
        }
      },
      LanguageModelToolResultPart: class {
        constructor(callId, content) {
          this.callId = callId;
          this.content = content;
        }
      }
    };
  }
  return originalRequire.apply(this, arguments);
};

const { CopilotConfigInjector } = await import("./out/config/CopilotConfigInjector.js");
const { createCopilotPulseModelProvider } = await import("./out/proxy/CopilotPulseModelProvider.js");
const { RouterLogic } = await import("./out/proxy/RouterLogic.js");
const http = await import("http");

const TEST_PORT = 3459;
const UPSTREAM_PORT = 9997;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0;
let failed = 0;

function check(condition, msg) {
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
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers),
    text,
    json: () => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
  };
}

async function runTests() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  Copilot Pulse — Agent & Tool Calling Test Suite    ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  const routerConfig = {
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`,
    apiKey: "test-key",
    cheapModel: "openai/gpt-4o-mini",
    strongModel: "anthropic/claude-3.5-sonnet",
    useDynamicTiers: true,
    threshold: 6.5,
    lowThreshold: 4.0,
    availableModels: ["gpt-4o-mini", "gpt-4o", "claude-3.5-sonnet", "o1"]
  };

  let lastUpstreamPayload = null;
  const mockUpstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      try {
        lastUpstreamPayload = JSON.parse(body);
      } catch {
        lastUpstreamPayload = body;
      }

      if (req.url.includes("/chat/completions")) {
        const isStream = req.headers["accept"] === "text/event-stream" || (lastUpstreamPayload && lastUpstreamPayload.stream);
        if (isStream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"${lastUpstreamPayload.model}","choices":[{"index":0,"delta":{"content":"Analyzing codebase..."}}]}\n\n`);
          res.write(`data: {"id":"chatcmpl-2","object":"chat.completion.chunk","model":"${lastUpstreamPayload.model}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"runTerminalCommand","arguments":"{\\"command\\":\\"npm test\\"}"}}]}}]}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model: lastUpstreamPayload.model,
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "Executing test suite...",
                tool_calls: [{
                  id: "call_123",
                  type: "function",
                  function: { name: "runTerminalCommand", arguments: '{"command":"npm test"}' }
                }]
              },
              finish_reason: "tool_calls"
            }]
          }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "claude-3.5-sonnet" }] }));
      }
    });
  });

  const metrics = [];

  const testProxyServer = http.createServer((req, res) => {
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
      let bodyStr = "";
      req.on("data", chunk => bodyStr += chunk);
      req.on("end", async () => {
        const requestJson = JSON.parse(bodyStr);
        const requestedModel = requestJson.model || "copilot-pulse-agent";
        const isStreaming = requestJson.stream !== false;

        // Prompt extraction
        let promptText = "";
        for (let i = (requestJson.messages?.length || 0) - 1; i >= 0; i--) {
          const msg = requestJson.messages[i];
          if (msg && msg.role === "user") {
            promptText = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            break;
          }
        }
        const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
        const isRouterModel = !requestJson.model ||
          requestJson.model === "copilot-pulse" ||
          requestJson.model === "copilot-pulse-agent" ||
          requestJson.model.includes("copilot-pulse");
        const isUtilityRequest = !isRouterModel;
        const isToolFollowUp = Array.isArray(requestJson.messages) &&
          requestJson.messages.some((m) => m.role === "tool" || m.role === "function");
        const shouldInjectBadge = !isUtilityRequest && !isToolFollowUp;

        const decision = RouterLogic.routeDecision(cleanPrompt, routerConfig);
        metrics.push({
          timestamp: Date.now(),
          routedModel: decision.model,
          prompt: cleanPrompt,
          score: decision.score,
          tier: decision.tier
        });

        // Forward to upstream mock
        requestJson.model = decision.model;
        const upstreamResp = await fetch(`${routerConfig.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": isStreaming ? "text/event-stream" : "application/json"
          },
          body: JSON.stringify(requestJson)
        });

        if (isStreaming) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (shouldInjectBadge) {
            const badgeMsg = `⚡ Copilot Pulse routed to: **${decision.model}**\n\n`;
            res.write(`data: {"id":"pulse_badge","object":"chat.completion.chunk","model":"${requestedModel}","choices":[{"index":0,"delta":{"content":"${badgeMsg}"}}]}\n\n`);
          }
          const text = await upstreamResp.text();
          const rewritten = text.replace(new RegExp(decision.model, "g"), requestedModel);
          res.write(rewritten);
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          const text = await upstreamResp.text();
          const rewritten = text.replace(new RegExp(decision.model, "g"), requestedModel);
          res.end(rewritten);
        }
      });
    } else if (url === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metrics));
    }
  });

  await new Promise(r => mockUpstream.listen(UPSTREAM_PORT, "127.0.0.1", r));
  await new Promise(r => testProxyServer.listen(TEST_PORT, "127.0.0.1", r));

  try {
    // TEST 1: Models Endpoint
    console.log("── TEST 1: GET /v1/models (Copilot Pulse Agent) ──");
    let r = await fetchJSON(`${BASE}/v1/models`);
    check(r.status === 200, "Status 200");
    let models = r.json()?.data?.map(m => m.id) || [];
    check(models.includes("copilot-pulse-agent"), 'Models list includes "copilot-pulse-agent"');
    check(models.includes("copilot-pulse"), 'Models list includes "copilot-pulse"');

    // TEST 2: Agent-mode request with tools and copilot-pulse-agent model
    console.log("\n── TEST 2: Agent Mode Request with Tools & copilot-pulse-agent ──");
    const complexAgentPrompt = "Architect a microservice distributed transaction orchestrator with saga pattern and CQRS";
    r = await fetchJSON(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "copilot-pulse-agent",
        messages: [
          { role: "system", content: "You are an autonomous AI software engineer." },
          { role: "user", content: complexAgentPrompt }
        ],
        tools: [
          { type: "function", function: { name: "runTerminalCommand", parameters: { type: "object", properties: { command: { type: "string" } } } } },
          { type: "function", function: { name: "editFile", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } }
        ],
        stream: true
      })
    });

    check(r.status === 200, `Agent request returned HTTP 200 (got ${r.status})`);
    check(lastUpstreamPayload && lastUpstreamPayload.tools && lastUpstreamPayload.tools.length === 2, "Tools payload preserved and forwarded upstream");
    check(lastUpstreamPayload.model.includes("claude") || lastUpstreamPayload.model.includes("gpt-4o") || lastUpstreamPayload.model.includes("o1"), `Complex task routed to Heavy/Medium tier model (${lastUpstreamPayload?.model})`);
    check(r.text.includes("copilot-pulse-agent"), "Stream response rewritten to requested model (copilot-pulse-agent)");
    check(r.text.includes("tool_calls"), "Tool calls streamed cleanly from upstream");

    // TEST 3: Tool follow-up turn (role: "tool")
    console.log("\n── TEST 3: Tool Follow-Up Turn (role: tool) ──");
    r = await fetchJSON(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "copilot-pulse-agent",
        messages: [
          { role: "user", content: "Run the test suite" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_123", type: "function", function: { name: "runTerminalCommand", arguments: '{"command":"npm test"}' } }]
          },
          {
            role: "tool",
            tool_call_id: "call_123",
            content: "PASS: 42 tests passed in 1.2s"
          }
        ],
        tools: [
          { type: "function", function: { name: "runTerminalCommand", parameters: {} } }
        ],
        stream: true
      })
    });

    check(r.status === 200, "Tool follow-up returned HTTP 200");
    check(!r.text.includes("pulse_badge"), "No duplicate badge injected during tool follow-up step");

    // TEST 4: Config Injection includes copilot-pulse-agent
    console.log("\n── TEST 4: CopilotConfigInjector registers copilot-pulse-agent ──");
    const injected = CopilotConfigInjector.injectConfig();
    check(injected === true, "CopilotConfigInjector.injectConfig() succeeded");

    // TEST 5: Non-streaming tool calling agent request
    console.log("\n── TEST 5: Non-Streaming Tool Calling Request ──");
    r = await fetchJSON(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "copilot-pulse-agent",
        messages: [{ role: "user", content: "list directory files" }],
        tools: [{ type: "function", function: { name: "listFiles", parameters: {} } }],
        stream: false
      })
    });

    check(r.status === 200, "Non-stream tool request returned HTTP 200");
    const jsonResp = r.json();
    check(jsonResp?.choices?.[0]?.message?.tool_calls?.length > 0, "Tool calls preserved in non-streaming response");
    check(jsonResp?.model === "copilot-pulse-agent", 'Model name rewritten to "copilot-pulse-agent"');

    // TEST 6: LanguageModelChatProvider creates copilot-pulse-agent
    console.log("\n── TEST 6: LanguageModelChatProvider info includes copilot-pulse-agent ──");
    const provider = createCopilotPulseModelProvider({
      getCopilotModels: () => [],
      getAvailableModels: () => ["gpt-4o-mini", "gpt-4o"],
      getRouterConfig: () => routerConfig,
      discover: async () => {},
      recordMetric: () => {}
    });
    const info = provider.provideLanguageModelChatInformation({}, {});
    check(Array.isArray(info) && info.some(m => m.id === "copilot-pulse-agent"), 'Provider exposes "copilot-pulse-agent"');
    check(info.every(m => m.capabilities?.toolCalling === true), "Provider declares toolCalling capability");

    // TEST 7: Metrics recording for Agent turns
    console.log("\n── TEST 7: Verify Agent Metrics Recorded ──");
    const metricsRes = await fetchJSON(`${BASE}/metrics`);
    const metricsData = metricsRes.json();
    check(Array.isArray(metricsData) && metricsData.length >= 3, `Metrics recorded for all agent steps (count=${metricsData?.length})`);

    console.log("\n══════════════════════════════════════════════════════");
    console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log("══════════════════════════════════════════════════════\n");
  } finally {
    mockUpstream.close();
    testProxyServer.close();
  }

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
