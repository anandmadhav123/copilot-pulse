#!/usr/bin/env node
/**
 * ⚡ Copilot Pulse — Comprehensive Ask & Agent Modes Test Suite
 * 
 * Deeply validates:
 * 1. Ask Mode: Chat participant (@copilotpulse), conversation history reconstruction,
 *    badge formatting, context pruning resilience, multi-turn tool loops, metrics sync.
 * 2. Agent Mode: LanguageModelChatProvider, tool call streaming, tool boost logic,
 *    BYOK proxy server (CORS, payload parsing, utility bypass, tool follow-up badge suppression,
 *    SSE chunk rewriting, non-streaming tools, copilot field stripping).
 * 3. Configuration Injector: chatLanguageModels.json, byok.json, settings.json.
 * 4. Model Discovery & Tiering: filtering internal models, dynamic bands (Light/Medium/Heavy).
 * 5. Dashboards & Status Bar: Webview summaries, HTTP dashboard, metrics signals.
 */

import Module from "module";
import http from "http";
import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Setup Mock VS Code Environment ───
const mockRegisteredParticipants = new Map();
const mockRegisteredProviders = new Map();
const mockStatusBarItems = [];
const mockOutputChannels = [];
const mockConfigListeners = [];

class MockLanguageModelChatMessage {
  constructor(role, content) {
    this.role = role;
    this.content = content;
  }
  static User(text) { return new MockLanguageModelChatMessage(1, text); }
  static Assistant(text) { return new MockLanguageModelChatMessage(2, text); }
}

class MockLanguageModelTextPart {
  constructor(value) { this.value = value; }
}

class MockLanguageModelToolCallPart {
  constructor(name, input, callId) {
    this.name = name;
    this.input = input;
    this.callId = callId || "call_" + Math.random().toString(36).slice(2, 8);
  }
}

class MockLanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

// Model sendRequest handler registry
let mockSendRequestHandler = null;

const createMockModel = (id, family, name) => ({
  id,
  family,
  name,
  vendor: "copilot",
  sendRequest: async (messages, options, token) => {
    if (mockSendRequestHandler) {
      return mockSendRequestHandler(id, messages, options, token);
    }
    const lastMsg = messages[messages.length - 1];
    const text = typeof lastMsg?.content === "string" ? lastMsg.content : (lastMsg?.content?.[0]?.text || "");

    if (text.includes("linked list")) {
      return {
        stream: (async function* () {
          yield new MockLanguageModelTextPart("A linked list is a linear data structure.");
        })()
      };
    } else if (text.includes("architect") || text.includes("distributed") || text.includes("microservices")) {
      return {
        stream: (async function* () {
          yield new MockLanguageModelTextPart("For scalable event-driven architecture, use Apache Kafka with CQRS.");
        })()
      };
    } else if (text.includes("insertion time complexity")) {
      return {
        stream: (async function* () {
          yield new MockLanguageModelTextPart("It runs in O(1) time complexity.");
        })()
      };
    }

    return {
      stream: (async function* () {
        yield new MockLanguageModelTextPart(`Response from ${name}`);
      })()
    };
  }
});

const mockCopilotChatModels = [
  createMockModel("gpt-4o-mini", "gpt-4o-mini", "GPT-4o Mini"),
  createMockModel("gpt-4o", "gpt-4o", "GPT-4o"),
  createMockModel("claude-3.5-sonnet", "claude-3.5-sonnet", "Claude 3.5 Sonnet"),
  createMockModel("o3-mini", "o3-mini", "o3-mini"),
  createMockModel("o1", "o1", "o1")
];

const mockVscode = {
  workspace: {
    getConfiguration: (section) => ({
      get: (key) => {
        const defaults = {
          baseUrl: "http://127.0.0.1:13498",
          apiKey: "test-token",
          cheapModel: "gpt-4o-mini",
          strongModel: "o1",
          useDynamicTiers: true,
          threshold: 6.5,
          lowThreshold: 4.0
        };
        return defaults[key];
      },
      inspect: () => ({ globalValue: true }),
      update: async () => {}
    }),
    // Real VS Code always provides this; the mock lacked it, which turned an
    // unguarded activate() call into a total activation failure.
    onDidChangeConfiguration: (listener) => {
      mockConfigListeners.push(listener);
      return { dispose: () => {} };
    }
  },
  window: {
    createOutputChannel: (name) => {
      const ch = {
        name,
        lines: [],
        appendLine: (l) => ch.lines.push(l),
        clear: () => { ch.lines = []; },
        show: () => {}
      };
      mockOutputChannels.push(ch);
      return ch;
    },
    createStatusBarItem: (alignment, priority) => {
      const item = {
        alignment,
        priority,
        text: "",
        tooltip: "",
        command: "",
        show: () => {},
        hide: () => {}
      };
      mockStatusBarItems.push(item);
      return item;
    },
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showInformationMessage: () => {},
    showErrorMessage: () => {}
  },
  StatusBarAlignment: { Right: 1, Left: 2 },
  commands: {
    registerCommand: (id, handler) => ({ id, handler, dispose: () => {} }),
    executeCommand: async () => {}
  },
  chat: {
    createChatParticipant: (id, handler) => {
      const participant = { id, handler, iconPath: null };
      mockRegisteredParticipants.set(id, participant);
      return participant;
    }
  },
  lm: {
    tools: [
      { name: "runTerminalCommand", description: "Run terminal command" },
      { name: "readFile", description: "Read file contents" },
      { name: "editFile", description: "Edit file in workspace" }
    ],
    selectChatModels: async (selector) => mockCopilotChatModels,
    invokeTool: async (name, opts, token) => {
      if (name === "failingTool") {
        throw new Error("Tool execution simulated failure");
      }
      return {
        content: [
          new MockLanguageModelTextPart(`Output from ${name}: ${JSON.stringify(opts.input || {})}`)
        ]
      };
    },
    registerLanguageModelChatProvider: (vendor, provider) => {
      mockRegisteredProviders.set(vendor, provider);
      return { dispose: () => mockRegisteredProviders.delete(vendor) };
    }
  },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatMessage: MockLanguageModelChatMessage,
  LanguageModelTextPart: MockLanguageModelTextPart,
  LanguageModelToolCallPart: MockLanguageModelToolCallPart,
  LanguageModelToolResultPart: MockLanguageModelToolResultPart,
  authentication: {
    getSession: async () => ({ accessToken: "mock-github-token" })
  }
};

// Patch Module require to intercept 'vscode'
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};

// Mock CopilotAuth before any module imports
const { CopilotAuth } = await import("./out/proxy/CopilotAuth.js");
CopilotAuth.getCopilotToken = async () => "mock-copilot-token";
CopilotAuth.fetchAvailableModels = async () => ["gpt-4o-mini", "gpt-4o", "claude-3.5-sonnet", "o3-mini", "o1"];

// Import compiled extension modules
const { RouterLogic } = await import("./out/proxy/RouterLogic.js");
const { ModelTiering, Band } = await import("./out/proxy/ModelTiering.js");
const { LocalProxyServer } = await import("./out/proxy/LocalProxyServer.js");
const { CopilotConfigInjector } = await import("./out/config/CopilotConfigInjector.js");
const { createCopilotPulseModelProvider } = await import("./out/proxy/CopilotPulseModelProvider.js");
const { DashboardWebviewProvider } = await import("./out/views/DashboardWebview.js");
const { activate, deactivate } = await import("./out/extension.js");

let totalPassed = 0;
let totalFailed = 0;

function test(name, fn) {
  try {
    fn();
    totalPassed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    totalFailed++;
    console.error(`  ❌ ${name}`);
    console.error(`     Error: ${err.message}\n${err.stack}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    totalPassed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    totalFailed++;
    console.error(`  ❌ ${name}`);
    console.error(`     Error: ${err.message}\n${err.stack}`);
  }
}

console.log("\n╔════════════════════════════════════════════════════════════════════╗");
console.log("║     ⚡ COPILOT PULSE — COMPREHENSIVE ASK & AGENT TEST SUITE        ║");
console.log("╚════════════════════════════════════════════════════════════════════╝\n");

// ══════════════════════════════════════════════════════════════════════
// SUITE 1: ASK MODE (Chat Participant, Multi-turn Context, Tool Exec)
// ══════════════════════════════════════════════════════════════════════
console.log("┌──────────────────────────────────────────────────────────────────┐");
console.log("│ 1. ASK MODE — CHAT PARTICIPANT & MULTI-TURN CONVERSATION         │");
console.log("└──────────────────────────────────────────────────────────────────┘");

const mockExtensionContext = {
  subscriptions: [],
  extensionUri: { fsPath: "/mock/ext/path" }
};

// Activate extension to wire all components
activate(mockExtensionContext);

const chatParticipant = mockRegisteredParticipants.get("copilotPulse.copilotpulse");

test("Chat participant 'copilotPulse.copilotpulse' registered", () => {
  assert.ok(chatParticipant, "Chat participant should be registered");
  assert.strictEqual(typeof chatParticipant.handler, "function");
});

await testAsync("Ask Mode: Light Tier routing for simple question", async () => {
  const streamChunks = [];
  const stream = {
    markdown: (text) => streamChunks.push(text),
    reference: () => {},
    progress: () => {}
  };

  const mockModel = {
    id: "gpt-4o-mini",
    family: "gpt-4o-mini",
    name: "GPT-4o Mini",
    sendRequest: async (messages, options, token) => ({
      stream: (async function* () {
        yield new MockLanguageModelTextPart("A linked list is a linear data structure.");
      })()
    })
  };

  const request = {
    prompt: "@copilotpulse what is a linked list?",
    model: mockModel
  };
  const chatContext = { history: [] };
  const cancellationToken = { isCancellationRequested: false };

  await chatParticipant.handler(request, chatContext, stream, cancellationToken);

  const fullText = streamChunks.join("");
  assert.ok(fullText.includes("Copilot Pulse Agent"), "Should include routing badge");
  assert.ok(fullText.includes("gpt-4o-mini") || fullText.includes("Light tier"), "Should route to Light Tier");
  assert.ok(fullText.includes("A linked list is a linear data structure"), "Should relay model answer");
});

await testAsync("Ask Mode: Heavy Tier routing for architecture design", async () => {
  const streamChunks = [];
  const stream = {
    markdown: (text) => streamChunks.push(text),
    reference: () => {},
    progress: () => {}
  };

  const mockModel = {
    id: "o1",
    family: "o1",
    name: "o1",
    sendRequest: async (messages, options, token) => ({
      stream: (async function* () {
        yield new MockLanguageModelTextPart("For scalable event-driven architecture, use Apache Kafka with CQRS.");
      })()
    })
  };

  const request = {
    prompt: "@copilotpulse architect a distributed event-driven microservices platform with saga pattern and CQRS",
    model: mockModel
  };
  const chatContext = { history: [] };
  const cancellationToken = { isCancellationRequested: false };

  await chatParticipant.handler(request, chatContext, stream, cancellationToken);

  const fullText = streamChunks.join("");
  assert.ok(fullText.includes("Score"), "Should include calculated score");
  assert.ok(fullText.includes("Heavy tier") || fullText.includes("o1") || fullText.includes("o3-mini"), "Should route to Heavy tier");
  assert.ok(fullText.includes("Apache Kafka with CQRS"), "Should output model text");
});

await testAsync("Ask Mode: Multi-turn history reconstruction cleans injected badges", async () => {
  let receivedMessages = [];
  mockSendRequestHandler = (id, messages, options, token) => {
    receivedMessages = messages;
    return {
      stream: (async function* () {
        yield new MockLanguageModelTextPart("It runs in O(1) time complexity.");
      })()
    };
  };

  const request = {
    prompt: "@copilotpulse and what is its insertion time complexity?"
  };

  const chatContext = {
    history: [
      { prompt: "@copilotpulse what is a hash table?" },
      {
        response: [
          { value: "`Copilot Pulse Agent` → **gpt-4o-mini** · Score **2.0/10** · Tier **Light tier**\n\nA hash table stores key-value pairs." }
        ]
      }
    ]
  };

  const streamChunks = [];
  const stream = { markdown: (t) => streamChunks.push(t) };
  const token = { isCancellationRequested: false };

  await chatParticipant.handler(request, chatContext, stream, token);
  mockSendRequestHandler = null;

  assert.strictEqual(receivedMessages.length, 3, "Should have 3 turns (User, Assistant, User)");
  assert.strictEqual(receivedMessages[0].content, "what is a hash table?", "Turn 1 cleaned @copilotpulse prefix");
  assert.strictEqual(receivedMessages[1].content, "A hash table stores key-value pairs.", "Turn 2 stripped injected badge lines");
  assert.strictEqual(receivedMessages[2].content, "and what is its insertion time complexity?", "Turn 3 cleaned current prompt");
});

await testAsync("Ask Mode: Tool execution loop in Chat Participant", async () => {
  let toolExecuted = false;
  mockSendRequestHandler = (id, messages, options, token) => {
    if (!toolExecuted) {
      toolExecuted = true;
      return {
        stream: (async function* () {
          yield new MockLanguageModelToolCallPart("runTerminalCommand", { command: "npm test" }, "call_t1");
        })()
      };
    }
    return {
      stream: (async function* () {
        yield new MockLanguageModelTextPart("All 45 unit tests passed successfully.");
      })()
    };
  };

  const request = {
    prompt: "@copilotpulse run the unit tests and tell me the result"
  };
  const streamChunks = [];
  const stream = { markdown: (t) => streamChunks.push(t) };
  const token = { isCancellationRequested: false };

  await chatParticipant.handler(request, { history: [] }, stream, token);
  mockSendRequestHandler = null;

  const fullText = streamChunks.join("");
  assert.ok(fullText.includes("Agent executing tool:"), "Should notify user of tool execution");
  assert.ok(fullText.includes("runTerminalCommand"), "Should name executed tool");
  assert.ok(fullText.includes("All 45 unit tests passed successfully"), "Should output final answer after tool completion");
});

await testAsync("Ask Mode: Tool error handling resilience", async () => {
  let turn = 0;
  mockSendRequestHandler = (id, messages, options, token) => {
    turn++;
    if (turn === 1) {
      return {
        stream: (async function* () {
          yield new MockLanguageModelToolCallPart("failingTool", {}, "call_fail");
        })()
      };
    }
    return {
      stream: (async function* () {
        yield new MockLanguageModelTextPart("Recovered from tool error.");
      })()
    };
  };

  const request = { prompt: "run failing tool" };
  const streamChunks = [];
  const stream = { markdown: (t) => streamChunks.push(t) };

  await chatParticipant.handler(request, { history: [] }, stream, { isCancellationRequested: false });
  mockSendRequestHandler = null;

  const fullText = streamChunks.join("");
  assert.ok(fullText.includes("Tool error"), "Should catch and format tool failure");
  assert.ok(fullText.includes("Recovered from tool error"), "Should continue next turn after error");
});

await testAsync("Ask Mode: Fallback on prompt-tsx pruning failure", async () => {
  let attempts = 0;
  mockSendRequestHandler = (id, messages, options, token) => {
    attempts++;
    if (attempts === 1) {
      throw new Error("No lowest priority node found in prompt tree");
    }
    return {
      stream: (async function* () {
        yield new MockLanguageModelTextPart("Recovered with clean single message.");
      })()
    };
  };

  const request = { prompt: "test prompt-tsx crash recovery" };
  const streamChunks = [];
  const stream = { markdown: (t) => streamChunks.push(t) };

  await chatParticipant.handler(request, { history: [] }, stream, { isCancellationRequested: false });
  mockSendRequestHandler = null;

  const fullText = streamChunks.join("");
  assert.ok(fullText.includes("Recovered with clean single message"), "Should transparently retry on prompt-tsx error");
});

// ══════════════════════════════════════════════════════════════════════
// SUITE 2: AGENT MODE (LanguageModelChatProvider & Tool Streaming)
// ══════════════════════════════════════════════════════════════════════
console.log("\n┌──────────────────────────────────────────────────────────────────┐");
console.log("│ 2. AGENT MODE — LANGUAGE MODEL PROVIDER & TOOL CALL STREAMING    │");
console.log("└──────────────────────────────────────────────────────────────────┘");

let mockCopilotModels = [
  { id: "gpt-4o-mini", family: "gpt-4o-mini", name: "GPT-4o Mini", sendRequest: async (msg, opt, tok) => ({
      stream: (async function* () { yield new MockLanguageModelTextPart("Light response"); })()
    })
  },
  { id: "claude-3.5-sonnet", family: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet", sendRequest: async (msg, opt, tok) => ({
      stream: (async function* () {
        yield new MockLanguageModelTextPart("Medium response");
        yield new MockLanguageModelToolCallPart("editFile", { path: "index.js", content: "console.log('hi');" }, "call_edit");
      })()
    })
  },
  { id: "o1", family: "o1", name: "o1", sendRequest: async (msg, opt, tok) => ({
      stream: (async function* () {
        yield new MockLanguageModelTextPart("Heavy reasoning response");
        yield new MockLanguageModelToolCallPart("runTerminalCommand", { command: "git status" }, "call_git");
      })()
    })
  }
];

let recordedMetricsFromProvider = [];
const provider = createCopilotPulseModelProvider({
  getCopilotModels: () => mockCopilotModels,
  getAvailableModels: () => ["gpt-4o-mini", "claude-3.5-sonnet", "o1"],
  getRouterConfig: () => ({
    cheapModel: "gpt-4o-mini",
    strongModel: "o1",
    useDynamicTiers: true,
    threshold: 6.5,
    lowThreshold: 4.0
  }),
  discover: async () => {},
  recordMetric: (prompt, config) => {
    recordedMetricsFromProvider.push({ prompt, timestamp: Date.now() });
  }
});

test("Provider exposes language model chat information for all 3 IDs", () => {
  const info = provider.provideLanguageModelChatInformation({}, {});
  assert.ok(Array.isArray(info), "Should return array of models");
  assert.strictEqual(info.length, 3);
  const ids = info.map(m => m.id);
  assert.ok(ids.includes("copilot-pulse"));
  assert.ok(ids.includes("copilot-pulse-agent"));
  assert.ok(ids.includes("copilot-pulse-router"));
  assert.ok(info.every(m => m.capabilities?.toolCalling === true), "All models declare toolCalling capability");
});

test("Provider token count estimation returns number", async () => {
  const count = await provider.provideTokenCount({}, "Hello world", {});
  assert.strictEqual(typeof count, "number");
});

await testAsync("Agent Mode Provider: Structured content extraction & Tool Boost", async () => {
  const reportedParts = [];
  const progress = {
    report: (part) => reportedParts.push(part)
  };

  // Agent message with complex array format and tools definition
  const agentMessages = [
    { role: "system", content: "You are an autonomous coding agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "Refactor database access layer to use connection pooling" }
      ]
    }
  ];

  const agentOptions = {
    tools: [{ name: "editFile" }],
    toolMode: 1
  };

  await provider.provideLanguageModelChatResponse(
    { id: "copilot-pulse-agent" },
    agentMessages,
    agentOptions,
    progress,
    {}
  );

  assert.ok(reportedParts.length >= 1, "Should relay streaming parts back to agent");
  assert.ok(reportedParts.some(p => p instanceof MockLanguageModelToolCallPart || p.name === "editFile" || p.name === "runTerminalCommand"),
    "Should relay tool calls intact to Agent host");
  assert.ok(recordedMetricsFromProvider.length >= 1, "Should record metric for agent request");
});

// ══════════════════════════════════════════════════════════════════════
// SUITE 3: BYOK LOCAL PROXY SERVER (HTTP Loopback & Streaming Proxy)
// ══════════════════════════════════════════════════════════════════════
console.log("\n┌──────────────────────────────────────────────────────────────────┐");
console.log("│ 3. BYOK PROXY SERVER — HTTP ENDPOINTS & AGENT SSE STREAMING      │");
console.log("└──────────────────────────────────────────────────────────────────┘");

const PROXY_PORT = 13499;
const MOCK_UPSTREAM_PORT = 13498;

let upstreamRequests = [];
const mockUpstreamServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    let parsedBody = null;
    try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
    upstreamRequests.push({ url: req.url, method: req.method, headers: req.headers, body: parsedBody });

    if (req.url.includes("/chat/completions")) {
      const isStreaming = req.headers["accept"] === "text/event-stream" || (parsedBody && parsedBody.stream);
      if (isStreaming) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: {"id":"c-1","object":"chat.completion.chunk","model":"${parsedBody?.model || 'upstream'}","choices":[{"index":0,"delta":{"content":"Planning changes..."}}]}\n\n`);
        res.write(`data: {"id":"c-2","object":"chat.completion.chunk","model":"${parsedBody?.model || 'upstream'}","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_99","type":"function","function":{"name":"editFile","arguments":"{\\"path\\":\\"app.js\\"}"}}]}}]}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "c-1",
          object: "chat.completion",
          model: parsedBody?.model || "upstream",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Done",
              tool_calls: [{ id: "call_99", type: "function", function: { name: "editFile", arguments: '{"path":"app.js"}' } }]
            },
            finish_reason: "tool_calls"
          }]
        }));
      }
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "o1" }] }));
    }
  });
});

await new Promise(r => mockUpstreamServer.listen(MOCK_UPSTREAM_PORT, "127.0.0.1", r));

const proxyServer = LocalProxyServer.getInstance(() => ({
  baseUrl: `http://127.0.0.1:${MOCK_UPSTREAM_PORT}`,
  apiKey: "test-token",
  cheapModel: "gpt-4o-mini",
  strongModel: "o1",
  useDynamicTiers: true,
  threshold: 6.5,
  lowThreshold: 4.0,
  availableModels: ["gpt-4o-mini", "claude-3.5-sonnet", "o1"]
}));

// CopilotAuth is already mocked at module start
CopilotAuth.getCopilotToken = async () => "mock-copilot-token";

// Ensure port 13499 is used for testing
const testHttpServer = http.createServer((req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";
  if ((url === "/v1/models" || url === "/models") && method === "GET") {
    proxyServer["handleModels"](req, res);
  } else if ((url === "/v1/chat/completions" || url === "/chat/completions") && (method === "POST" || method === "OPTIONS")) {
    proxyServer["handleChatCompletions"](req, res);
  } else if (url === "/metrics" && method === "GET") {
    proxyServer["handleMetrics"](req, res);
  } else if (url === "/" || url === "/dashboard") {
    proxyServer["handleDashboard"](req, res);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

await new Promise(r => testHttpServer.listen(PROXY_PORT, "127.0.0.1", r));

async function fetchProxy(path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
}

await testAsync("Proxy: GET /v1/models returns registered models", async () => {
  const res = await fetchProxy("/v1/models");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json?.object, "list");
  const ids = res.json?.data?.map(m => m.id) || [];
  assert.ok(ids.includes("copilot-pulse"), "Contains copilot-pulse");
  assert.ok(ids.includes("copilot-pulse-agent"), "Contains copilot-pulse-agent");
  assert.ok(ids.includes("copilot-pulse-router"), "Contains copilot-pulse-router");
});

await testAsync("Proxy: OPTIONS CORS Preflight handles agent webview requests", async () => {
  const res = await fetchProxy("/v1/chat/completions", {
    method: "OPTIONS",
    headers: {
      "Origin": "vscode-webview://example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type, Authorization"
    }
  });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  assert.ok(res.headers["access-control-allow-methods"]?.includes("POST"));
});

await testAsync("Proxy: Agent Mode Request with Tools routes to Heavy model & rewrites SSE", async () => {
  upstreamRequests = [];
  const res = await fetchProxy("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer test-key" },
    body: JSON.stringify({
      model: "copilot-pulse-agent",
      messages: [
        { role: "system", content: "You are an autonomous engineer." },
        {
          role: "user",
          content: [{ type: "text", text: "Architect a scalable microservices event-driven system" }]
        }
      ],
      tools: [
        { type: "function", function: { name: "editFile", parameters: { type: "object" } } }
      ],
      intent: "agentAction",
      copilot_references: [{ type: "file", uri: "file:///app.js" }],
      stream: true
    })
  });

  assert.strictEqual(res.status, 200);
  assert.ok(res.text.includes("data:"), "Should return SSE stream");
  assert.ok(res.text.includes("pulse_badge") || res.text.includes("Copilot Pulse routed to"), "Should inject routing badge for user prompt");
  assert.ok(res.text.includes("copilot-pulse-agent"), "Should rewrite model name in SSE chunk to copilot-pulse-agent");
  assert.ok(res.text.includes("tool_calls"), "Should stream tool calls cleanly");

  // Verify upstream received sanitized payload
  assert.strictEqual(upstreamRequests.length, 1);
  const upReq = upstreamRequests[0].body;
  assert.strictEqual(upReq.intent, undefined, "Copilot intent stripped from upstream payload");
  assert.strictEqual(upReq.copilot_references, undefined, "Copilot references stripped from upstream payload");
  assert.strictEqual(upReq.model, "o1", "Routed to o1 (Heavy tier) due to tools & complexity");
  assert.strictEqual(upReq.tools?.length, 1, "Tools forwarded to upstream");
});

await testAsync("Proxy: Tool follow-up step (role: 'tool') suppresses duplicate badge", async () => {
  const res = await fetchProxy("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse-agent",
      messages: [
        { role: "user", content: "Run tests" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_99", type: "function", function: { name: "editFile", arguments: '{"path":"app.js"}' } }]
        },
        {
          role: "tool",
          tool_call_id: "call_99",
          content: "File app.js updated successfully"
        }
      ],
      tools: [{ type: "function", function: { name: "editFile" } }],
      stream: true
    })
  });

  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes("pulse_badge"), "Must NOT inject badge during tool follow-up turn");
  assert.ok(res.text.includes("tool_calls") || res.text.includes("Planning changes"), "Streams tool execution response cleanly");
});

await testAsync("Proxy: Internal Copilot utility request bypass (copilot-utility-small)", async () => {
  const metricsCountBefore = proxyServer.getMetrics().length;

  const res = await fetchProxy("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-utility-small",
      messages: [{ role: "user", content: "generate title for current conversation" }],
      stream: true
    })
  });

  assert.strictEqual(res.status, 200);
  assert.ok(!res.text.includes("pulse_badge"), "Utility requests must NEVER inject badges");
  const metricsCountAfter = proxyServer.getMetrics().length;
  assert.strictEqual(metricsCountBefore, metricsCountAfter, "Utility requests must not pollute user metrics store");
});

await testAsync("Proxy: Non-streaming Agent request (stream: false)", async () => {
  const res = await fetchProxy("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "copilot-pulse-agent",
      messages: [{ role: "user", content: "Summarize this diff" }],
      tools: [{ type: "function", function: { name: "editFile" } }],
      stream: false
    })
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json?.model, "copilot-pulse-agent", "Rewrites model name in non-streaming JSON response");
  assert.ok(res.json?.choices?.[0]?.message?.tool_calls?.length >= 1, "Preserves tool_calls in non-streaming response");
});

// ══════════════════════════════════════════════════════════════════════
// SUITE 4: CONFIGURATION INJECTOR & ENVIRONMENT SETUP
// ══════════════════════════════════════════════════════════════════════
console.log("\n┌──────────────────────────────────────────────────────────────────┐");
console.log("│ 4. CONFIGURATION INJECTOR — CHAT CONFIG & SETTINGS VERIFICATION  │");
console.log("└──────────────────────────────────────────────────────────────────┘");

test("CopilotConfigInjector injects modern chatLanguageModels.json", () => {
  const injected = CopilotConfigInjector.injectConfig();
  assert.strictEqual(injected, true, "injectConfig should succeed");

  const home = os.homedir();
  const clmPath = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json")
    : process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "chatLanguageModels.json")
    : path.join(home, ".config", "Code", "User", "chatLanguageModels.json");

  assert.ok(fs.existsSync(clmPath), `chatLanguageModels.json should exist at ${clmPath}`);
  const clmData = JSON.parse(fs.readFileSync(clmPath, "utf-8"));
  const pulse = clmData.find(p => p._copilotPulseMarker === "copilot-pulse-local-proxy");
  assert.ok(pulse, "chatLanguageModels.json should contain Copilot Pulse entry");
  assert.strictEqual(pulse.vendor, "customendpoint");
  assert.strictEqual(pulse.apiType, "chat-completions");
  const modelIds = pulse.models.map(m => m.id);
  assert.ok(modelIds.includes("copilot-pulse-agent"), "Config contains copilot-pulse-agent");
  assert.ok(pulse.models.every(m => m.toolCalling === true), "Every injected model has toolCalling=true");
});

test("CopilotConfigInjector injects legacy byok.json", () => {
  const byokPath = path.join(os.homedir(), ".config", "github-copilot", "byok.json");
  assert.ok(fs.existsSync(byokPath), `byok.json should exist at ${byokPath}`);
  const byokData = JSON.parse(fs.readFileSync(byokPath, "utf-8"));
  assert.strictEqual(byokData["OpenRouter-baseUrl"], "http://127.0.0.1:3456");
  assert.ok(byokData["OpenRouter-models-config"]?.["copilot-pulse-agent"], "byok.json has copilot-pulse-agent configuration");
});

test("CopilotConfigInjector enables Agent Host settings in settings.json", () => {
  const home = os.homedir();
  const settingsPath = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Code", "User", "settings.json")
    : process.platform === "win32"
    ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Code", "User", "settings.json")
    : path.join(home, ".config", "Code", "User", "settings.json");

  assert.ok(fs.existsSync(settingsPath), `settings.json should exist at ${settingsPath}`);
  const settingsData = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  assert.strictEqual(settingsData["chat.agentHost.byokModels.enabled"], true, "byokModels.enabled should be true");
  assert.strictEqual(settingsData["github.copilot.advanced"]?.["customModels.enabled"], true, "customModels.enabled should be true");
});

// ══════════════════════════════════════════════════════════════════════
// SUITE 5: DASHBOARDS & METRICS ACCUMULATION
// ══════════════════════════════════════════════════════════════════════
console.log("\n┌──────────────────────────────────────────────────────────────────┐");
console.log("│ 5. METRICS, WEBVIEW & STANDALONE HTTP DASHBOARDS                 │");
console.log("└──────────────────────────────────────────────────────────────────┘");

await testAsync("HTTP Dashboard: /dashboard and /metrics serve live data", async () => {
  const dashRes = await fetchProxy("/dashboard");
  assert.strictEqual(dashRes.status, 200);
  assert.ok(dashRes.text.includes("Copilot Pulse Dashboard"));
  assert.ok(dashRes.text.includes("totalRequests"));
  assert.ok(dashRes.text.includes("costSaved"));

  const metricsRes = await fetchProxy("/metrics");
  assert.strictEqual(metricsRes.status, 200);
  assert.strictEqual(metricsRes.headers["access-control-allow-origin"], "*");
  assert.ok(Array.isArray(metricsRes.json), "Metrics endpoint returns JSON array");
  assert.ok(metricsRes.json.length > 0, "Metrics store has recorded queries");

  for (const m of metricsRes.json) {
    assert.ok(m.timestamp > 0);
    assert.ok(m.routedModel || m.model);
    assert.ok(typeof m.score === "number" || typeof m.complexityScore === "number");
    assert.ok(m.signals, "Each record must have 5 signals");
    assert.ok(typeof m.signals.keyword === "number");
    assert.ok(typeof m.signals.intent === "number");
    assert.ok(typeof m.signals.code === "number");
    assert.ok(typeof m.signals.context === "number");
    assert.ok(typeof m.signals.vector === "number");
  }
});

test("Webview Dashboard Provider computes accurate summaries", () => {
  const dashboardProvider = new DashboardWebviewProvider({ fsPath: "/mock" });
  let postedMessages = [];
  dashboardProvider["_view"] = {
    webview: {
      postMessage: (msg) => postedMessages.push(msg),
      options: {},
      html: ""
    }
  };

  dashboardProvider.updateDashboard();
  assert.strictEqual(postedMessages.length, 1);
  const msg = postedMessages[0];
  assert.strictEqual(msg.type, "update");
  assert.ok(msg.summary.totalCount > 0);
  assert.ok(typeof msg.summary.savingsPercent === "number");
  assert.ok(typeof msg.summary.avgScore === "string");
  assert.ok(typeof msg.summary.taskCounts === "object");
});

test("Status Bar item updates dynamically with latest routed model", () => {
  const lastStatusBar = mockStatusBarItems[mockStatusBarItems.length - 1];
  assert.ok(lastStatusBar, "Status bar item should exist");
  assert.ok(lastStatusBar.text.includes("$(zap)"), "Status bar contains zap icon");
});

// ─── Teardown test servers ───
mockUpstreamServer.close();
testHttpServer.close();
deactivate();

console.log("\n══════════════════════════════════════════════════════════════════════");
console.log(`  TEST RESULTS: ${totalPassed} PASSED, ${totalFailed} FAILED, ${totalPassed + totalFailed} TOTAL`);
console.log("══════════════════════════════════════════════════════════════════════\n");

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
