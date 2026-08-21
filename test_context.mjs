/**
 * Standalone verification of Copilot Pulse's multi-turn context assembly.
 *
 * It mirrors extension.ts -> buildChatMessages() with stubbed
 * vscode.LanguageModelChatMessage.User/Assistant, and asserts that:
 *   - prior user + assistant turns are replayed in order,
 *   - our injected "`Copilot Pulse` → ..." header lines are stripped,
 *   - the current prompt is appended last as a User message.
 *
 * Run: node test_context.mjs
 */
import assert from "node:assert";

// --- stub of vscode.LanguageModelChatMessage ---
const LanguageModelChatMessage = {
  User: (content) => ({ role: "user", content }),
  Assistant: (content) => ({ role: "assistant", content }),
};

// --- copy of buildChatMessages() logic from extension.ts ---
function buildChatMessages(history, currentPrompt) {
  const messages = [];
  for (const turn of history || []) {
    if (!turn) continue;
    if (typeof turn.prompt === "string") {
      if (turn.prompt.trim().length > 0) {
        messages.push(LanguageModelChatMessage.User(turn.prompt));
      }
      continue;
    }
    if (Array.isArray(turn.response)) {
      let text = "";
      for (const part of turn.response) {
        const v = part && part.value;
        if (typeof v === "string") text += v;
        else if (v && typeof v.value === "string") text += v.value;
      }
      text = text
        .split("\n")
        .filter((line) => !line.startsWith("`Copilot Pulse`"))
        .join("\n")
        .trim();
      if (text.length > 0) messages.push(LanguageModelChatMessage.Assistant(text));
    }
  }
  messages.push(LanguageModelChatMessage.User(currentPrompt));
  return messages;
}

// --- simulate a 2-turn history exactly like VS Code would provide ---
// Turn 1: user asked, assistant replied (with our routing header prepended).
const history = [
  { prompt: "My name is Madhav and my favorite language is Rust." },
  {
    response: [
      { value: { value: "`Copilot Pulse` → **gpt-4o** · Score **2.1/10** · Tier **Light tier**\n\n" } },
      { value: { value: "Nice to meet you, Madhav! Rust is a great choice." } },
    ],
  },
];

const messages = buildChatMessages(history, "What is my name and favorite language?");

console.log("Reconstructed messages sent to the model:\n");
messages.forEach((m, i) => console.log(`  [${i}] ${m.role.padEnd(9)} : ${m.content}`));
console.log();

// --- assertions ---
assert.strictEqual(messages.length, 3, "should be user + assistant + current user");
assert.strictEqual(messages[0].role, "user");
assert.match(messages[0].content, /Madhav/);
assert.strictEqual(messages[1].role, "assistant");
assert.ok(
  !messages[1].content.includes("Copilot Pulse"),
  "routing header must be stripped from assistant context"
);
assert.match(messages[1].content, /Nice to meet you/);
assert.strictEqual(messages[2].role, "user");
assert.match(messages[2].content, /favorite language/);

console.log("✅ PASS — full prior context (user + assistant turns) is replayed to the model,");
console.log("          header lines are stripped, and the new prompt is appended last.");

