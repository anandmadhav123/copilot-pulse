#!/usr/bin/env node
/**
 * ⚡ Copilot Pulse — Agent Loop END-TO-END tests.
 *
 * These differ from the unit tests in test_routing_v2.js in an important way:
 * they drive the REAL `executeAgentTurn` through the REAL registered chat
 * participant, using mock models that reproduce actual failure modes.
 *
 * This is the layer that was missing when the "No lowest priority node found"
 * bug shipped: `isPromptSizeError()` was unit-tested and passing, while the
 * recovery ladder that consumes it had never been executed once.
 *
 * Covered:
 *   A. Context-overflow ladder (prompt-tsx "No lowest priority node found")
 *   B. Stuck-tool-loop escalation
 *   C. Empty-response escalation
 *   D. Escalation budget cap (no infinite retry)
 *   E. Healthy turns never escalate
 *   F. Tool catalogue is only attached to action prompts
 */

import Module from "module";
import assert from "assert";

// ─────────────────────────── Mock VS Code ───────────────────────────
const mockRegisteredParticipants = new Map();

class MockLanguageModelChatMessage {
  constructor(role, content) { this.role = role; this.content = content; }
  static User(text) { return new MockLanguageModelChatMessage(1, text); }
  static Assistant(text) { return new MockLanguageModelChatMessage(2, text); }
}
class MockLanguageModelTextPart { constructor(value) { this.value = value; } }
class MockLanguageModelToolCallPart {
  constructor(name, input, callId) {
    this.name = name; this.input = input;
    this.callId = callId || "call_" + Math.random().toString(36).slice(2, 8);
  }
}
class MockLanguageModelToolResultPart {
  constructor(callId, content) { this.callId = callId; this.content = content; }
}

/** Per-test scripted behaviour, keyed by model id. */
let scriptedResponse = null;
/** Every sendRequest observed, in order: { modelId, hasTools, messageCount }. */
let requestLog = [];

const createMockModel = (id, name) => ({
  id,
  family: id,
  name,
  vendor: "copilot",
  sendRequest: async (messages, options, token) => {
    requestLog.push({
      modelId: id,
      hasTools: !!(options && options.tools && options.tools.length),
      messageCount: messages.length
    });
    if (scriptedResponse) return scriptedResponse(id, messages, options);
    return { stream: (async function* () { yield new MockLanguageModelTextPart(`ok from ${id}`); })() };
  }
});

const mockCopilotChatModels = [
  createMockModel("gpt-4o-mini", "GPT-4o Mini"),
  createMockModel("o3-mini", "o3-mini"),
  createMockModel("gpt-4o", "GPT-4o"),
  createMockModel("o1", "o1")
];

const TOOL_CATALOGUE = [
  { name: "runTerminalCommand", description: "Run a terminal command" },
  { name: "readFile", description: "Read file contents" },
  { name: "editFile", description: "Edit a file" }
];

let invokedTools = [];

const mockVscode = {
  workspace: {
    getConfiguration: () => ({
      get: (key) => ({
        baseUrl: "http://127.0.0.1:13599",
        apiKey: "test",
        cheapModel: "gpt-4o-mini",
        strongModel: "o1",
        useDynamicTiers: true,
        threshold: 6.5,
        lowThreshold: 4.0
      })[key],
      inspect: () => ({ globalValue: true }),
      update: async () => {}
    })
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, clear: () => {}, show: () => {} }),
    createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show: () => {}, hide: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    showInformationMessage: () => {},
    showErrorMessage: () => {}
  },
  StatusBarAlignment: { Right: 1, Left: 2 },
  commands: { registerCommand: () => ({ dispose: () => {} }), executeCommand: async () => {} },
  chat: {
    createChatParticipant: (id, handler) => {
      const p = { id, handler, iconPath: null };
      mockRegisteredParticipants.set(id, p);
      return p;
    }
  },
  lm: {
    tools: TOOL_CATALOGUE,
    selectChatModels: async () => mockCopilotChatModels,
    invokeTool: async (name, opts) => {
      invokedTools.push({ name, input: opts.input });
      return { content: [new MockLanguageModelTextPart(`Output from ${name}`)] };
    },
    registerLanguageModelChatProvider: () => ({ dispose: () => {} })
  },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelChatMessage: MockLanguageModelChatMessage,
  LanguageModelTextPart: MockLanguageModelTextPart,
  LanguageModelToolCallPart: MockLanguageModelToolCallPart,
  LanguageModelToolResultPart: MockLanguageModelToolResultPart,
  authentication: { getSession: async () => ({ accessToken: "mock" }) }
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "vscode") return mockVscode;
  return originalRequire.apply(this, arguments);
};

const { CopilotAuth } = await import("./out/proxy/CopilotAuth.js");
CopilotAuth.getCopilotToken = async () => "mock-token";
CopilotAuth.fetchAvailableModels = async () => mockCopilotChatModels.map((m) => m.id);

const { conversationStore } = await import("./out/routing/ConversationState.js");
const { activate } = await import("./out/extension.js");
const { LocalProxyServer } = await import("./out/proxy/LocalProxyServer.js");

// ─────────────────────────── Harness ───────────────────────────
let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
  }
}

const context = { subscriptions: [], extensionUri: { fsPath: "/tmp/pulse" }, globalState: { get: () => undefined, update: async () => {} } };
activate(context);
const participant = mockRegisteredParticipants.get("copilotPulse.copilotpulse");
assert.ok(participant, "chat participant must be registered");

/** Runs one @copilotpulse turn and returns the full rendered markdown. */
async function runTurn(prompt, history = []) {
  const chunks = [];
  const stream = {
    markdown: (t) => chunks.push(typeof t === "string" ? t : String(t)),
    reference: () => {},
    progress: () => {},
    button: () => {}
  };
  requestLog = [];
  invokedTools = [];
  await participant.handler(
    { prompt, model: mockCopilotChatModels[0], references: [] },
    { history },
    stream,
    { isCancellationRequested: false }
  );
  return chunks.join("");
}

/** Stream that throws mid-iteration, like a lazy prompt-tsx render failure. */
function throwingStream(message) {
  return {
    stream: (async function* () {
      throw new Error(message);
      // eslint-disable-next-line no-unreachable
      yield null;
    })()
  };
}

function textStream(text) {
  return { stream: (async function* () { yield new MockLanguageModelTextPart(text); })() };
}

function toolStream(name, input) {
  return {
    stream: (async function* () {
      yield new MockLanguageModelToolCallPart(name, input, "call_fixed");
    })()
  };
}

console.log("\n══════════════════════════════════════════════════════");
console.log("  AGENT LOOP — END-TO-END RECOVERY & ESCALATION");
console.log("══════════════════════════════════════════════════════\n");

console.log("── A. Context-overflow ladder (the reported bug) ──");

await testAsync("Recovers from prompt-tsx overflow instead of dying", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => {
    attempts++;
    // Reproduce the REPORTED failure precisely: the overflow recurs, because
    // re-sending the identical oversized payload fails identically. Two
    // failures is what produced "⛔ could not continue" in the wild, so a
    // single-failure test would not exercise the bug at all.
    if (attempts <= 2) return throwingStream("No lowest priority node found (path: Gte)");
    return textStream("Here is the completed answer.");
  };

  const out = await runTurn("fix the failing build in this project");

  assert.ok(
    !out.includes("could not continue"),
    "must NOT dead-end the way the reported bug did"
  );
  assert.ok(out.includes("Here is the completed answer."), "must deliver the recovered answer");
  assert.ok(attempts >= 3, "must have retried past the repeated overflow");
});

await testAsync("Escalates to a stronger model on overflow", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => {
    attempts++;
    if (attempts === 1) return throwingStream("No lowest priority node found (path: Gte)");
    return textStream("Recovered.");
  };

  const out = await runTurn("fix the failing build in this project");
  const modelsUsed = [...new Set(requestLog.map((r) => r.modelId))];

  assert.ok(
    out.includes("Escalating to") || modelsUsed.length > 1,
    `expected an escalation; models used: ${modelsUsed.join(", ")}`
  );
});

await testAsync("Drops history, then tools, when overflow persists", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => {
    attempts++;
    // Persistent overflow: only succeed once tools have been dropped.
    if (attempts <= 4) return throwingStream("No lowest priority node found (path: Gte)");
    return textStream("Finally fits.");
  };

  const history = [
    { prompt: "earlier question about the build" },
    { response: [{ value: "earlier long answer" }] }
  ];
  const out = await runTurn("fix the failing build in this project", history);

  assert.ok(
    out.includes("without the earlier conversation history") || out.includes("without tool definitions"),
    "must announce a context-reduction step"
  );
  // Once tools are dropped, at least one request must carry no tools.
  const withoutTools = requestLog.filter((r) => !r.hasTools);
  assert.ok(withoutTools.length > 0, "must eventually retry without tool definitions");
});

await testAsync("Gives actionable advice when nothing can be shrunk further", async () => {
  conversationStore.clear();
  scriptedResponse = () => throwingStream("No lowest priority node found (path: Gte)");

  const out = await runTurn("fix the failing build in this project");

  assert.ok(out.includes("too large"), "must explain the request is too large");
  assert.ok(
    out.includes("new chat") || out.includes("fewer files"),
    "must tell the user what to do next"
  );
});

await testAsync("Terminates — no infinite retry loop on permanent overflow", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => { attempts++; return throwingStream("No lowest priority node found (path: Gte)"); };

  await runTurn("fix the failing build in this project");

  assert.ok(attempts < 15, `ladder must terminate quickly, took ${attempts} attempts`);
});

console.log("\n── B. Stuck tool loop escalation ──");

await testAsync("Escalates when the model repeats an identical tool call", async () => {
  conversationStore.clear();
  scriptedResponse = () => toolStream("runTerminalCommand", { cmd: "./gradlew build" });

  const out = await runTurn("run the gradle build and fix any errors");

  assert.ok(out.includes("Escalating to"), "must announce an escalation");
  assert.ok(
    out.includes("repeated the same tool call"),
    "must name the stuck-loop reason"
  );
});

await testAsync("Stuck loop does not run away — bounded by the budget cap", async () => {
  conversationStore.clear();
  let calls = 0;
  scriptedResponse = () => { calls++; return toolStream("runTerminalCommand", { cmd: "./gradlew build" }); };

  await runTurn("run the gradle build and fix any errors");

  // 25 turn cap is the hard ceiling; the escalation cap should stop it earlier.
  assert.ok(calls <= 26, `expected bounded execution, got ${calls} model calls`);
});

console.log("\n── C. Empty-response escalation ──");

await testAsync("Escalates when the model returns nothing", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => {
    attempts++;
    if (attempts === 1) return { stream: (async function* () { })() };
    return textStream("Second model answered.");
  };

  const out = await runTurn("add a unit test for the parser");

  assert.ok(
    out.includes("Escalating to") || out.includes("Second model answered."),
    "must recover from an empty response"
  );
});

console.log("\n── D. Healthy turns ──");

await testAsync("A healthy answer never escalates", async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("Here is a clean, complete answer.");

  const out = await runTurn("add a unit test for the parser");

  assert.ok(!out.includes("Escalating to"), "healthy turns must not escalate");
  assert.ok(!out.includes("could not continue"), "healthy turns must not error");
  assert.equal(requestLog.length, 1, "healthy turns must issue exactly one request");
});

await testAsync("A healthy tool call completes without escalation", async () => {
  conversationStore.clear();
  let attempts = 0;
  scriptedResponse = () => {
    attempts++;
    if (attempts === 1) return toolStream("readFile", { path: "a.ts" });
    return textStream("Done — the file was read and updated.");
  };

  const out = await runTurn("read this file and update it");

  assert.ok(out.includes("Agent executing tool"), "must show the tool invocation");
  assert.ok(invokedTools.length >= 1, "the tool must actually be invoked");
  assert.ok(!out.includes("Escalating to"), "a productive tool call must not escalate");
});

console.log("\n── E. Intent-gated tool attachment ──");

await testAsync('REGRESSION: "do it for me" MUST receive tools', async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("Working on it.");

  await runTurn("do it for me");

  assert.ok(requestLog.length > 0, "a request must have been made");
  assert.ok(
    requestLog.every((r) => r.hasTools),
    "a continuation prompt must carry tools — without them the agent replies " +
      '"I\'m unable to execute commands directly on your machine"'
  );
});

await testAsync('REGRESSION: "do it for me" must NOT route to a Light model', async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("Working on it.");

  const out = await runTurn("do it for me");

  assert.ok(!out.includes("Light tier"), `must not use the Light tier, got: ${out.slice(0, 120)}`);
  assert.ok(
    !requestLog.some((r) => r.modelId === "gpt-4o-mini"),
    "must not route a tool-calling turn to gpt-4o-mini"
  );
});

await testAsync("Short affirmatives keep tools", async () => {
  for (const prompt of ["go ahead", "yes please", "continue"]) {
    conversationStore.clear();
    scriptedResponse = () => textStream("ok");
    await runTurn(prompt);
    assert.ok(
      requestLog.every((r) => r.hasTools),
      `"${prompt}" must carry tools`
    );
  }
});

await testAsync("An agentic conversation keeps tools on later questions", async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("ok");

  const history = [{ prompt: "fix the failing build in this project" }];
  // First establish the agentic conversation.
  await runTurn("fix the failing build in this project", history);
  // Now a bare question in the SAME conversation must still carry tools.
  await runTurn("what is the status?", history);

  assert.ok(
    requestLog.every((r) => r.hasTools),
    "an agentic session must keep tools available on follow-ups"
  );
});

await testAsync("Pure Q&A in a fresh chat carries NO tool catalogue", async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("A linked list is a linear data structure.");

  await runTurn("what is a linked list?");

  assert.ok(requestLog.length > 0, "a request must have been made");
  assert.ok(
    requestLog.every((r) => !r.hasTools),
    "a pure question in a fresh chat should stay cheap and tool-less"
  );
});

await testAsync("Action prompts DO carry the tool catalogue", async () => {
  conversationStore.clear();
  scriptedResponse = () => textStream("Working on it.");

  await runTurn("fix the failing build in this project");

  assert.ok(requestLog.some((r) => r.hasTools), "action prompts must receive tools");
});

// ─────────────────────────── Summary ───────────────────────────
try { LocalProxyServer.getInstance().stop(); } catch { /* ignore */ }

console.log("\n══════════════════════════════════════════════════════");
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log("══════════════════════════════════════════════════════\n");

process.exit(failed > 0 ? 1 : 0);



