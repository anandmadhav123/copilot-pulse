import * as vscode from "vscode";
import { LocalProxyServer } from "./proxy/LocalProxyServer";
import { CopilotConfigInjector } from "./config/CopilotConfigInjector";
import { OpenAiClient } from "./proxy/OpenAiClient";
import { DashboardWebviewProvider } from "./views/DashboardWebview";
import { RouterConfig } from "./proxy/RouterLogic";
import { ModelTiering, Band } from "./proxy/ModelTiering";
import { createCopilotPulseModelProvider } from "./proxy/CopilotPulseModelProvider";
import { conversationStore, toolArgsKey, ToolSignature } from "./routing/ConversationState";
import {
  evaluateTurn,
  pickEscalationModel,
  isEscalatableError,
  isPromptSizeError,
  EscalationReason,
  EscalationSettings,
  DEFAULT_ESCALATION_SETTINGS,
  TurnObservation
} from "./routing/EscalationPolicy";
import { detectDissatisfaction, requiresTools } from "./routing/PromptFeatures";

// Model IDs/families discovered from the GitHub Copilot subscription.
// These drive the dynamic Light/Medium/Heavy tiering.
let availableModelsCache: string[] = [];
// The actual Copilot LanguageModelChat objects, kept so @copilotpulse can
// route the request to the specific model the router selects.
let copilotModels: any[] = [];
// Diagnostics: whether the Language Model Provider API exists and whether we
// successfully registered the "Copilot Pulse (Auto-Router)" model with it.
let providerApiAvailable = false;
let providerRegistered = false;

/**
 * Auto-discovers the models available in the user's GitHub Copilot subscription
 * via the VS Code Language Model API and rebuilds the tier source list.
 */
async function discoverCopilotModels(): Promise<void> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    copilotModels = models || [];
    let ids = copilotModels
      .map((m: any) => m.family || m.id || m.name)
      .filter((x: any) => typeof x === "string" && x.length > 0);
      
    // Try to fetch from the raw Copilot API for the most accurate list
    try {
      const { CopilotAuth } = require("./proxy/CopilotAuth");
      const token = await CopilotAuth.getCopilotToken();
      const apiModels = await CopilotAuth.fetchAvailableModels(token);
      if (apiModels && apiModels.length > 0) {
        ids = [...ids, ...apiModels];
      }
    } catch (apiErr: any) {
      console.warn("[Copilot Pulse] Failed to fetch models from raw API:", apiErr.message);
    }
    
    const uniqueIds = Array.from(new Set(ids)) as string[];
    availableModelsCache = uniqueIds.filter(id => {
      const lower = id.toLowerCase();
      // Exclude non-chat and internal models from routing options
      return !lower.includes("utility") && 
             !lower.includes("embedding") && 
             !lower.includes("bge") && 
             !lower.includes("search") && 
             !lower.includes("similarity");
    });
    console.log(
      `[Copilot Pulse] Discovered ${availableModelsCache.length} Copilot models: ${availableModelsCache.join(", ")}`
    );
  } catch (e: any) {
    console.error("[Copilot Pulse] Failed to discover Copilot models:", e?.message || e);
  }
}

/**
 * Finds the Copilot LanguageModelChat that best matches a routed model id/family.
 */
function pickCopilotModel(decisionModel: string): any | undefined {
  if (!copilotModels.length) return undefined;
  const target = (decisionModel || "").toLowerCase();
  let m = copilotModels.find(
    (cm: any) =>
      (cm.family || "").toLowerCase() === target || (cm.id || "").toLowerCase() === target
  );
  if (m) return m;
  m = copilotModels.find((cm: any) => {
    const fam = (cm.family || "").toLowerCase();
    return fam.length > 0 && (target.includes(fam) || fam.includes(target));
  });
  return m;
}

/**
 * Reconstructs the full multi-turn conversation (like normal Copilot) from the
 * chat history plus the current prompt, so the routed model receives context.
 *
 * Uses duck-typing (turn.prompt for user turns, turn.response[] for assistant
 * turns) so it works regardless of exact VS Code type identities.
 */
function buildChatMessages(history: any[] | undefined, currentPrompt: string): any[] {
  const messages: any[] = [];
  const cleanCurrentPrompt = (currentPrompt || "").replace(/^@copilotpulse\s*/i, "").trim();

  for (const turn of history || []) {
    if (!turn) continue;

    // User (request) turn.
    if (typeof turn.prompt === "string") {
      const cleanTurnPrompt = turn.prompt.replace(/^@copilotpulse\s*/i, "").trim();
      if (cleanTurnPrompt.length > 0) {
        messages.push(vscode.LanguageModelChatMessage.User(cleanTurnPrompt));
      }
      continue;
    }

    // Assistant (response) turn — concatenate its markdown/text parts.
    if (Array.isArray(turn.response)) {
      let text = "";
      for (const part of turn.response) {
        const v = part && part.value;
        if (typeof v === "string") {
          text += v;
        } else if (v && typeof v.value === "string") {
          text += v.value; // MarkdownString
        }
      }
      // Strip our injected routing header lines and error traces so they don't pollute context.
      text = text
        .split("\n")
        .filter((line) => !line.startsWith("`Copilot Pulse") && !line.startsWith("_Routing was recorded"))
        .join("\n")
        .trim();
      if (text.length > 0) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(cleanCurrentPrompt || "Hello"));
  return messages;
}

/**
 * Copilot-internal tool names that require the native participant's
 * toolInvocationToken.  Our @copilotpulse chat participant does NOT
 * have that token, so invoking them will always throw "Invalid stream".
 *
 * Instead of crashing, we:
 *  1. Skip the invocation entirely.
 *  2. Feed a synthetic success result back to the model so it
 *     continues generating inline code/instructions.
 *  3. Show a one-time tip suggesting Agent Mode via the model picker.
 */
const COPILOT_INTERNAL_TOOLS = new Set([
  "copilot_createFile",
  "copilot_editFile",
  "copilot_createNewWorkspace",
  "copilot_deleteFile",
  "copilot_renameFile",
  "copilot_moveFile",
  "copilot_openFile",
  "copilot_readProjectStructure",
  "copilot_readFile",
  "copilot_runTerminalCommand",
  "copilot_runCommand",
  "copilot_searchFiles",
  "copilot_getTerminalOutput",
  "copilot_insertEdit",
]);

/**
 * Derives a stable id for a chat session.
 *
 * VS Code doesn't expose a session id on ChatContext, so we anchor on the
 * first user turn in the history — it stays constant for the life of the
 * conversation and changes as soon as the user opens a new chat.
 */
function getConversationId(chatContext: any): string {
  try {
    const history = (chatContext && chatContext.history) || [];
    for (const turn of history) {
      if (turn && typeof turn.prompt === "string" && turn.prompt.trim().length > 0) {
        const seed = turn.prompt.trim().slice(0, 120);
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
          hash = (hash * 31 + seed.charCodeAt(i)) | 0;
        }
        return `conv_${hash}`;
      }
    }
  } catch {
    /* fall through */
  }
  return "conv_new";
}

/** Reads the auto-escalation settings from VS Code configuration. */
function getEscalationSettings(): EscalationSettings {
  const cfg = vscode.workspace.getConfiguration("copilotPulse");
  const configured = cfg.get<string[]>("escalation.triggers");
  const triggers =
    Array.isArray(configured) && configured.length > 0
      ? (configured.filter((t) =>
          Object.values(EscalationReason).includes(t as EscalationReason)
        ) as EscalationReason[])
      : DEFAULT_ESCALATION_SETTINGS.triggers;

  return {
    enabled: cfg.get<boolean>("escalation.enabled") ?? DEFAULT_ESCALATION_SETTINGS.enabled,
    maxEscalations:
      cfg.get<number>("escalation.maxEscalationsPerConversation") ??
      DEFAULT_ESCALATION_SETTINGS.maxEscalations,
    triggers,
    stuckLoopThreshold:
      cfg.get<number>("escalation.stuckLoopThreshold") ?? DEFAULT_ESCALATION_SETTINGS.stuckLoopThreshold,
    toolErrorThreshold:
      cfg.get<number>("escalation.toolErrorThreshold") ?? DEFAULT_ESCALATION_SETTINGS.toolErrorThreshold
  };
}

/**
 * Maximum time a single tool invocation may take before we give up on it.
 * A tool that never settles (e.g. a terminal command waiting on input) would
 * otherwise freeze the agent loop forever, which looks exactly like the
 * extension "stopping abruptly".
 */
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

/** Rejects with `message` if `promise` has not settled within `ms`. */
function withTimeout(promise: any, ms: number, message: string): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(message));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Executes an agentic conversation turn with model routing and tool calling support.
 *
 * **Design note – Copilot internal tools:**
 * When the user types `@copilotpulse` the request is handled by *our* chat
 * participant, **not** by Copilot's native participant.  Copilot's own tools
 * (`copilot_createFile`, `copilot_editFile`, …) need a special
 * `toolInvocationToken` that only the native participant holds.  If we try
 * to call `vscode.lm.invokeTool` for those tools we will always get
 * "Invalid stream".
 *
 * To prevent this we detect Copilot-internal tool names and return a
 * synthetic text result that tells the model "the file was created" (or
 * similar).  The model then continues generating inline code output, and
 * we show the user a tip to use the Model Picker → "Copilot Pulse Agent"
 * for full native file-editing capabilities.
 */
async function executeAgentTurn(
  model: any,
  initialMessages: any[],
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  routing?: {
    conversationId: string;
    band: Band | null;
    availableModels: string[];
    settings: EscalationSettings;
    /** Tools to offer the model (already filtered by intent). */
    tools?: any[];
  }
): Promise<void> {
  const messages = [...initialMessages];
  // Long, real-world agent tasks (build → read errors → edit → re-build) very
  // often need far more than 8 tool round-trips. The old limit made the agent
  // stop silently in the middle of a task.
  const maxTurns = Math.max(
    1,
    vscode.workspace.getConfiguration("copilotPulse").get<number>("maxAgentTurns") ?? 25
  );
  let currentTurn = 0;
  let shownAgentModeTip = false;
  let producedAnyOutput = false;
  let consecutiveEmptyTurns = 0;
  // Context-overflow recovery ladder state (see the prompt-size handler below).
  let droppedHistory = false;
  let toolsDisabled = false;
  const cleanPrompt = (request.prompt || "").replace(/^@copilotpulse\s*/i, "").trim() || "Hello";

  // ── Auto-escalation state ────────────────────────────────────────────
  let activeModel = model;
  let activeBand: Band | null = routing?.band ?? null;
  const conversationId = routing?.conversationId || "default";
  const escalationSettings = routing?.settings ?? DEFAULT_ESCALATION_SETTINGS;
  const availableModels = routing?.availableModels ?? [];

  /**
   * Attempts to move the conversation up one tier. Returns true when a
   * stronger model was successfully swapped in.
   */
  const tryEscalate = (obs: TurnObservation): boolean => {
    const record = conversationStore.get(conversationId);
    const decision = evaluateTurn(obs, record, activeBand, escalationSettings);
    if (!decision.shouldEscalate || !decision.nextBand) return false;

    const nextModel = pickEscalationModel(decision.nextBand, availableModels);
    if (!nextModel) return false;

    const resolved = pickCopilotModel(nextModel);
    if (!resolved) return false;

    // Don't "escalate" onto the model we are already using.
    const currentId = (activeModel && (activeModel.id || activeModel.family)) || "";
    const nextId = (resolved.id || resolved.family || "");
    if (currentId && nextId && currentId === nextId) return false;

    activeModel = resolved;
    activeBand = decision.nextBand;
    conversationStore.noteEscalation(conversationId, decision.nextBand);

    const displayName = resolved.name || resolved.family || resolved.id || nextModel;
    stream.markdown(
      `\n\n> ⬆️ **Escalating to \`${displayName}\` (${decision.nextBand} tier)** — ${decision.message}.\n\n`
    );
    console.log(
      `[Copilot Pulse] Escalated to ${displayName} (${decision.nextBand}) — reason=${decision.reason}`
    );
    return true;
  };

  // Tools to offer the model. The caller filters these by intent so a pure
  // Q&A turn never carries the (very large) tool catalogue.
  const availableTools = routing?.tools
    ?? ((vscode.lm && Array.isArray(vscode.lm.tools)) ? vscode.lm.tools : []);

  // A user message like "still broken" escalates before we even start.
  if (detectDissatisfaction(cleanPrompt)) {
    tryEscalate({ userDissatisfied: true });
  }

  while (currentTurn < maxTurns && !token.isCancellationRequested) {
    currentTurn++;

    const options: any = {};
    if (availableTools.length > 0 && !toolsDisabled) {
      options.tools = availableTools;
    }

    let chatResponse: any;
    try {
      chatResponse = await activeModel.sendRequest(messages, options, token);
    } catch (err: any) {
      // A model-capability failure (context length, tool support, content
      // filter…) means a stronger model may well succeed — escalate and retry
      // the same turn rather than burning a fallback on the same model.
      if (isEscalatableError(err) && tryEscalate({ error: err })) {
        currentTurn--; // the escalated attempt replaces this turn
        continue;
      }

      // Fallback 1: retry without tools if the underlying model doesn't support the tools option
      if (options.tools) {
        try {
          chatResponse = await activeModel.sendRequest(messages, {}, token);
        } catch (innerErr: any) {
          // Fallback 2: if prompt-tsx has a pruning failure (e.g., "No lowest priority node found"), retry with clean single message
          try {
            const singleUserMsg = [vscode.LanguageModelChatMessage.User(cleanPrompt)];
            chatResponse = await activeModel.sendRequest(singleUserMsg, {}, token);
          } catch {
            if (tryEscalate({ error: innerErr })) {
              currentTurn--;
              continue;
            }
            throw innerErr;
          }
        }
      } else {
        // Fallback 2: retry with clean single message if history tree pruning failed
        try {
          const singleUserMsg = [vscode.LanguageModelChatMessage.User(cleanPrompt)];
          chatResponse = await activeModel.sendRequest(singleUserMsg, {}, token);
        } catch {
          if (tryEscalate({ error: err })) {
            currentTurn--;
            continue;
          }
          throw err;
        }
      }
    }

    const toolCallsToExecute: any[] = [];
    const seenCallIds = new Set<string>();
    let assistantTurnText = "";
    let streamFailure: any = null;
    // Escalation signals gathered while running this turn.
    let maxToolRepeat = 0;
    let malformedToolCall = false;
    let toolErrorCount = 0;
    const turnToolSignatures: ToolSignature[] = [];

    // ────────────────────────────────────────────────────────────────
    // Consume the model stream.
    //
    // A failure *during* iteration (network reset, content filter, provider
    // hiccup) used to propagate out of this function and abort the entire
    // participant response — the user just saw the answer stop mid-sentence.
    // We now capture it, keep everything already produced, and decide below
    // whether we can safely continue.
    // ────────────────────────────────────────────────────────────────
    try {
      if (chatResponse && chatResponse.stream && typeof chatResponse.stream[Symbol.asyncIterator] === "function") {
        for await (const part of chatResponse.stream) {
          if (token.isCancellationRequested) break;

          // Check if this part is a tool call
          const isToolCall =
            (vscode.LanguageModelToolCallPart && part instanceof vscode.LanguageModelToolCallPart) ||
            (part && typeof part.name === "string" && typeof part.callId === "string");

          if (isToolCall) {
            // Some models re-emit the same callId across chunks. A duplicated
            // callId produces a malformed assistant message and the NEXT
            // sendRequest throws — which looked like a random mid-task stop.
            const callId = String(part.callId);
            if (seenCallIds.has(callId)) continue;
            seenCallIds.add(callId);
            toolCallsToExecute.push(part);

            // ── Stuck-loop detection ──────────────────────────────────
            // Re-issuing the *same* tool with the *same* arguments means the
            // model is spinning rather than making progress — the strongest
            // real-world signal that this tier can't finish the task.
            const sig: ToolSignature = { name: String(part.name), argsKey: toolArgsKey(part.input) };
            turnToolSignatures.push(sig);
            const repeats = conversationStore.noteToolCall(conversationId, sig);
            if (repeats > maxToolRepeat) maxToolRepeat = repeats;

            if (part.input !== undefined && part.input !== null && typeof part.input === "string") {
              // Tool args should be an object; a raw string usually means the
              // model emitted unparseable JSON.
              try {
                JSON.parse(part.input);
              } catch {
                malformedToolCall = true;
              }
            }

            stream.markdown(`\n> 🔧 **Agent executing tool:** \`${part.name}\`...\n\n`);
          } else {
            const textVal = typeof part === "string" ? part : (part && part.value !== undefined ? part.value : "");
            if (textVal) {
              assistantTurnText += textVal;
              producedAnyOutput = true;
              stream.markdown(textVal);
            }
          }
        }
      } else if (chatResponse && chatResponse.text) {
        for await (const fragment of chatResponse.text) {
          if (token.isCancellationRequested) break;
          assistantTurnText += fragment;
          producedAnyOutput = true;
          stream.markdown(fragment);
        }
      }
    } catch (streamErr: any) {
      streamFailure = streamErr;
      console.error("[Copilot Pulse] Agent stream interrupted:", streamErr?.message || streamErr);
    }

    if (token.isCancellationRequested) {
      return;
    }

    if (streamFailure) {
      const failMsg = streamFailure?.message || String(streamFailure);

      // ── Context-overflow recovery ────────────────────────────────────
      // `No lowest priority node found (path: …)` means Copilot's prompt-tsx
      // renderer could not fit the request into the model's context window.
      // Re-sending the identical payload is guaranteed to fail again, so we
      // progressively SHRINK the request instead of blindly retrying.
      if (isPromptSizeError(streamFailure)) {
        // Step 1 — move to a model with a bigger context window.
        if (tryEscalate({ error: streamFailure })) {
          currentTurn--;
          continue;
        }
        // Step 2 — drop the conversation history, keep only the live request.
        if (!droppedHistory) {
          droppedHistory = true;
          messages.length = 0;
          messages.push(vscode.LanguageModelChatMessage.User(cleanPrompt));
          stream.markdown(
            `\n> ℹ️ *The prompt exceeded the model's context window — retrying without the earlier conversation history.*\n\n`
          );
          currentTurn--;
          continue;
        }
        // Step 3 — drop the tool definitions (they can be tens of thousands
        // of tokens on their own).
        if (!toolsDisabled) {
          toolsDisabled = true;
          stream.markdown(
            `\n> ℹ️ *Still too large — retrying without tool definitions.*\n\n`
          );
          currentTurn--;
          continue;
        }
        // Nothing left to shrink.
        stream.markdown(
          `\n\n> ⛔ **The request is too large for the available models.**\n>\n` +
            `> Try starting a new chat, or narrowing the request to fewer files.\n`
        );
        return;
      }

      if (toolCallsToExecute.length === 0) {
        stream.markdown(`\n\n> ⚠️ *Stream interrupted: ${failMsg}. Recovering…*\n\n`);
        consecutiveEmptyTurns++;
        if (consecutiveEmptyTurns >= 2 || currentTurn >= maxTurns) {
          stream.markdown(
            `\n\n> ⛔ **Copilot Pulse could not continue:** \`${failMsg}\`\n>\n> Please retry your request.\n`
          );
          return;
        }
        messages.push(
          vscode.LanguageModelChatMessage.User(
            "The previous response was cut off by a transient network error. Please continue from where you stopped."
          )
        );
        continue;
      }
      stream.markdown(`\n> ⚠️ *Partial stream (${failMsg}); continuing with the received tool calls.*\n\n`);
    }

    // Detect a completely empty turn (no text, no tool calls). Silently
    // breaking here is what made the agent "stop for no reason".
    if (!streamFailure && toolCallsToExecute.length === 0 && assistantTurnText.trim().length === 0) {
      consecutiveEmptyTurns++;
      // An empty answer is a capability signal: try a stronger model before
      // giving up on the user.
      if (tryEscalate({ text: assistantTurnText, toolCalls: [] })) {
        currentTurn--;
        continue;
      }
      if (consecutiveEmptyTurns >= 2) {
        stream.markdown(
          producedAnyOutput
            ? `\n\n> ℹ️ *The model returned an empty response — the output above is the final result.*\n`
            : `\n\n> ⚠️ **The model returned an empty response.** Please rephrase your request or try again.\n`
        );
        return;
      }
      messages.push(
        vscode.LanguageModelChatMessage.User("Your last response was empty. Please continue with the task.")
      );
      continue;
    }
    consecutiveEmptyTurns = 0;

    // The model produced prose but explicitly said it cannot do the task.
    if (toolCallsToExecute.length === 0 && tryEscalate({ text: assistantTurnText })) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          "Please complete the task using the available tools."
        )
      );
      continue;
    }

    // Stuck in a tool loop, or the tool arguments were malformed → escalate
    // before executing the same failing call yet again.
    if (
      (maxToolRepeat >= escalationSettings.stuckLoopThreshold || malformedToolCall) &&
      tryEscalate({ maxToolRepeat, malformedToolCall, toolCalls: turnToolSignatures })
    ) {
      messages.push(
        vscode.LanguageModelChatMessage.User(
          "The previous approach was repeating without progress. Re-assess the problem and take a different approach."
        )
      );
      continue;
    }

    // If no tool calls were generated or invokeTool is unavailable, we are done
    if (toolCallsToExecute.length === 0 || !vscode.lm || typeof vscode.lm.invokeTool !== "function") {
      conversationStore.noteTurn(conversationId, activeBand ?? Band.MEDIUM, true);
      return;
    }

    // Execute each tool call and prepare result parts
    const assistantMessageParts: any[] = [];
    if (assistantTurnText.trim().length > 0) {
      assistantMessageParts.push(
        vscode.LanguageModelTextPart
          ? new vscode.LanguageModelTextPart(assistantTurnText)
          : { value: assistantTurnText }
      );
    }

    const userResultParts: any[] = [];
    let hadInternalToolSkip = false;

    for (const toolCall of toolCallsToExecute) {
      if (token.isCancellationRequested) return;
      assistantMessageParts.push(toolCall);

      // ────────────────────────────────────────────────────────
      // Copilot-internal tool?  Skip invocation, return synthetic result.
      // ────────────────────────────────────────────────────────
      if (COPILOT_INTERNAL_TOOLS.has(toolCall.name)) {
        hadInternalToolSkip = true;
        const syntheticMsg =
          `Tool "${toolCall.name}" completed successfully. ` +
          `Please provide the full code/content inline in your response so the user can copy it.`;
        const syntheticContent = [
          vscode.LanguageModelTextPart
            ? new vscode.LanguageModelTextPart(syntheticMsg)
            : { value: syntheticMsg }
        ];
        if (vscode.LanguageModelToolResultPart) {
          userResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, syntheticContent));
        } else {
          userResultParts.push({ callId: toolCall.callId, content: syntheticContent });
        }
        continue;
      }

      // ────────────────────────────────────────────────────────
      // Normal (non-internal) tool — invoke with full error handling.
      // ────────────────────────────────────────────────────────
      try {
        const invocationOpts: any = {
          input: toolCall.input || {},
        };
        // Only pass toolInvocationToken if the request actually provides one
        if ((request as any).toolInvocationToken) {
          invocationOpts.toolInvocationToken = (request as any).toolInvocationToken;
        }
        const result = await withTimeout(
          vscode.lm.invokeTool(toolCall.name, invocationOpts, token),
          TOOL_TIMEOUT_MS,
          `Tool "${toolCall.name}" did not respond within ${Math.round(TOOL_TIMEOUT_MS / 1000)}s`
        );

        const content = (result && result.content) ? result.content : [
          vscode.LanguageModelTextPart ? new vscode.LanguageModelTextPart("Tool completed successfully") : { value: "Tool completed successfully" }
        ];

        if (vscode.LanguageModelToolResultPart) {
          userResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, content));
        } else {
          userResultParts.push({ callId: toolCall.callId, content });
        }
      } catch (toolErr: any) {
        // If ANY tool invocation fails with "Invalid stream" or similar auth errors,
        // treat it like a Copilot-internal tool and return synthetic success.
        const errMessage = toolErr?.message || String(toolErr);
        const isAuthError = errMessage.includes("Invalid stream") ||
                            errMessage.includes("not authorized") ||
                            errMessage.includes("invocation token") ||
                            errMessage.includes("permission");

        if (isAuthError) {
          hadInternalToolSkip = true;
          const syntheticMsg =
            `Tool "${toolCall.name}" is not available in this context. ` +
            `Please provide the full code/content inline in your response instead.`;
          const syntheticContent = [
            vscode.LanguageModelTextPart
              ? new vscode.LanguageModelTextPart(syntheticMsg)
              : { value: syntheticMsg }
          ];
          if (vscode.LanguageModelToolResultPart) {
            userResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, syntheticContent));
          } else {
            userResultParts.push({ callId: toolCall.callId, content: syntheticContent });
          }
        } else {
          // Genuine tool error (network timeout, tool bug, etc.)
          toolErrorCount++;
          const errMsg = `Tool error: ${errMessage}`;
          stream.markdown(`\n> ⚠️ *${errMsg}*\n\n`);
          if (vscode.LanguageModelToolResultPart) {
            userResultParts.push(new vscode.LanguageModelToolResultPart(toolCall.callId, [
              vscode.LanguageModelTextPart ? new vscode.LanguageModelTextPart(errMsg) : { value: errMsg }
            ]));
          } else {
            userResultParts.push({ callId: toolCall.callId, content: [{ value: errMsg }] });
          }
        }
      }
    }

    // Several tools failed in a row — a stronger model usually picks better
    // arguments / a better strategy.
    if (toolErrorCount >= escalationSettings.toolErrorThreshold) {
      tryEscalate({ toolErrors: toolErrorCount, toolCalls: turnToolSignatures });
    }
    conversationStore.noteTurn(conversationId, activeBand ?? Band.MEDIUM, toolErrorCount === 0);

    // Show a one-time tip when Copilot-internal tools were skipped
    if (hadInternalToolSkip && !shownAgentModeTip) {
      shownAgentModeTip = true;
      stream.markdown(
        `\n> 💡 **Tip:** For full file editing and terminal capabilities, select ` +
        `**Copilot Pulse (Smart Router)** or **Copilot Pulse Agent** from the ` +
        `**Model Picker dropdown** (top of chat) instead of using \`@copilotpulse\`. ` +
        `This enables native Agent Mode with direct workspace access.\n\n`
      );
    }

    // Append to conversation history for the next agent turn
    let historyAppended = false;
    try {
      if (vscode.LanguageModelChatMessage && assistantMessageParts.length > 0 && userResultParts.length > 0) {
        const asstRole = (vscode.LanguageModelChatMessageRole && vscode.LanguageModelChatMessageRole.Assistant) || 2;
        const userRole = (vscode.LanguageModelChatMessageRole && vscode.LanguageModelChatMessageRole.User) || 1;
        messages.push(new vscode.LanguageModelChatMessage(asstRole, assistantMessageParts));
        messages.push(new vscode.LanguageModelChatMessage(userRole, userResultParts));
        historyAppended = true;
      }
    } catch (histErr: any) {
      console.warn("[Copilot Pulse] Could not build structured tool history:", histErr?.message || histErr);
    }

    if (!historyAppended) {
      // Plain-text fallback keeps the loop alive instead of sending a
      // malformed message that would make the next turn throw.
      messages.push(
        vscode.LanguageModelChatMessage.Assistant(
          assistantTurnText || `Executed ${toolCallsToExecute.map((t) => t.name).join(", ")}`
        )
      );
      messages.push(vscode.LanguageModelChatMessage.User("Tool execution complete. Continue with response."));
    }
  }

  // The loop ended because the turn budget ran out — tell the user instead of
  // stopping without a word (the most-reported "stops abruptly" symptom).
  if (currentTurn >= maxTurns && !token.isCancellationRequested) {
    stream.markdown(
      `\n\n> ⏸️ **Paused after ${maxTurns} tool steps** to avoid an endless loop.\n>\n` +
        `> Reply **"continue"** to let Copilot Pulse carry on with the remaining work.\n`
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("[Copilot Pulse] Activating extension...");

  const getRouterConfig = (): RouterConfig => {
    const config = vscode.workspace.getConfiguration("copilotPulse");
    return {
      baseUrl: config.get<string>("baseUrl") || "https://openrouter.ai/api/v1",
      apiKey: config.get<string>("apiKey") || "",
      cheapModel: config.get<string>("cheapModel") || "openai/gpt-4o-mini",
      strongModel: config.get<string>("strongModel") || "openai/gpt-4o",
      useDynamicTiers: config.get<boolean>("useDynamicTiers") ?? true,
      threshold: config.get<number>("threshold") ?? 6.5,
      lowThreshold: config.get<number>("lowThreshold") ?? 4.0,
      routingV2: config.get<boolean>("routing.v2") ?? true,
      stickiness: config.get<number>("routing.stickiness") ?? 2.5,
      availableModels: availableModelsCache
    };
  };

  // 1. Inject Copilot BYOK Configuration (chatLanguageModels.json + byok.json)
  //    This registers "Copilot Pulse (Smart Router)" as a BYOK custom endpoint
  //    pointing to the local proxy — works in both Chat and Agent modes.
  //    By using the custom endpoint, Copilot uses its native UI renderer and
  //    bypasses the 'prompt-tsx' crash entirely.
  // Only advertise the BYOK model-picker entries when they can actually work
  // (they proxy to an upstream endpoint that needs baseUrl + apiKey). A dead
  // entry in the picker just produces "not configured" on every prompt.
  const isByokConfigured = (): boolean => {
    const c = getRouterConfig();
    return !!(c.baseUrl && c.baseUrl.trim() && c.apiKey && c.apiKey.trim());
  };

  try {
    CopilotConfigInjector.injectConfig(isByokConfigured());
    CopilotConfigInjector.enableAgentHostSettings(vscode);
  } catch (cfgErr: any) {
    // Never let config injection abort activation — the router still works
    // through the chat participant and the model provider.
    console.warn("[Copilot Pulse] Config injection failed:", cfgErr?.message || cfgErr);
  }

  // Re-evaluate whenever the user edits the Pulse settings, so the picker
  // entries appear the moment an API key is added (and vanish if removed).
  // Feature-detected + guarded: anything that throws inside activate() would
  // take down the whole extension, not just this listener.
  try {
    if (vscode.workspace && typeof vscode.workspace.onDidChangeConfiguration === "function") {
      context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e: any) => {
          try {
            if (e && typeof e.affectsConfiguration === "function" && !e.affectsConfiguration("copilotPulse")) {
              return;
            }
            CopilotConfigInjector.injectConfig(isByokConfigured());
          } catch (err: any) {
            console.warn("[Copilot Pulse] Config re-injection failed:", err?.message || err);
          }
        })
      );
    }
  } catch (subErr: any) {
    console.warn("[Copilot Pulse] Could not watch configuration changes:", subErr?.message || subErr);
  }

  // 2. Register Dashboard Webview View
  const dashboardProvider = new DashboardWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardWebviewProvider.viewType, dashboardProvider)
  );

  // 3. Start Local Proxy Server & attach metric listener for live updates
  const proxyServer = LocalProxyServer.getInstance(getRouterConfig);
  proxyServer.setOnMetricListener(() => {
    dashboardProvider.updateDashboard();
    
    // Implement Option 3: Dynamic Status Bar
    const metrics = proxyServer.getMetrics();
    if (metrics.length > 0) {
      // recordMetric() unshifts, so index 0 is the MOST RECENT record.
      // Reading the last element showed the oldest routing decision (and, once
      // the 200-record cap was hit, a permanently frozen one).
      const latest = metrics[0];
      statusBarItem.text = `$(zap) ${latest.routedModel}`;
      statusBarItem.tooltip = `Routed to ${latest.routedModel} (${latest.tier})`;
    }
  });

  // The proxy server is configured to use OpenRouter or custom Base URLs.
  // We removed nativeRouteCallback because it hits Zscaler firewalls directly.
  proxyServer.nativeRouteCallback = undefined;

  proxyServer.start().then(
    (success) => {
      if (success) {
        console.log("[Copilot Pulse] Proxy server started successfully.");
      } else {
        console.warn("[Copilot Pulse] Proxy server could not start; routing falls back to the chat participant.");
      }
    },
    (startErr: any) => {
      // An unhandled rejection here is reported by VS Code as an extension crash.
      console.error("[Copilot Pulse] Proxy server start failed:", startErr?.message || startErr);
    }
  );

  // 4. Create Status Bar Item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(zap) Copilot Pulse";
  statusBarItem.tooltip = "Copilot Pulse: Intelligent Model Router Active";
  statusBarItem.command = "copilotPulse.openDashboard";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 5. Auto-discover the GitHub Copilot subscription models and build tiers.
  discoverCopilotModels()
    .then(() => dashboardProvider.updateDashboard())
    .catch((e: any) => console.warn("[Copilot Pulse] Initial model discovery failed:", e?.message || e));
  // Re-discover whenever the available Copilot models change (sign-in, plan change, etc.)
  if (vscode.lm && typeof vscode.lm.onDidChangeChatModels === "function") {
    context.subscriptions.push(
      vscode.lm.onDidChangeChatModels(() => {
        discoverCopilotModels().catch((e: any) =>
          console.warn("[Copilot Pulse] Model re-discovery failed:", e?.message || e)
        );
      })
    );
  }

  // 6. Commands
  const openDashboardCmd = vscode.commands.registerCommand("copilotPulse.openDashboard", () => {
    vscode.commands.executeCommand("workbench.view.extension.copilot-pulse-container");
  });

  const testConnCmd = vscode.commands.registerCommand("copilotPulse.testConnection", async () => {
    const config = getRouterConfig();
    if (!config.baseUrl || !config.apiKey) {
      vscode.window.showErrorMessage("Copilot Pulse is not configured. Please set Base URL and API Key in VS Code Settings.");
      return;
    }

    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Testing Copilot Pulse provider connection...",
      cancellable: false
    }, async () => {
      const res = await OpenAiClient.listModels(config.baseUrl!, config.apiKey!);
      if (res.success) {
        // NOTE: tiers are built from the Copilot subscription models
        // (see discoverCopilotModels), so we do NOT overwrite them here.
        vscode.window.showInformationMessage(`✅ Connected! Provider exposes ${res.models.length} models.`);
      } else {
        vscode.window.showErrorMessage(`❌ Connection failed: ${res.message}`);
      }
    });
  });

  context.subscriptions.push(openDashboardCmd, testConnCmd);

  // 6b. Command: show the discovered Copilot models grouped into tiers.
  const showModelsCmd = vscode.commands.registerCommand("copilotPulse.showModels", async () => {
    await discoverCopilotModels();
    const channel = vscode.window.createOutputChannel("Copilot Pulse");
    channel.clear();
    channel.appendLine("=== Copilot Pulse — Supported Models (from your GitHub Copilot subscription) ===\n");
    if (!copilotModels.length) {
      channel.appendLine("No models discovered yet.");
      channel.appendLine("Make sure GitHub Copilot Chat is installed, you're signed in, and you've");
      channel.appendLine("granted language-model access (accept the consent prompt on first use).");
    } else {
      channel.appendLine(`Discovered ${copilotModels.length} model(s):`);
      for (const m of copilotModels) {
        channel.appendLine(`  • ${m.name || m.family || m.id}   [family=${m.family || "?"}, vendor=${m.vendor || "?"}, id=${m.id || "?"}]`);
      }
      channel.appendLine("\n--- Routing tiers (Light / Medium / Heavy) ---");
      channel.appendLine(ModelTiering.describeTiers(availableModelsCache));
      channel.appendLine("\nLight  = score < " + (getRouterConfig().lowThreshold ?? 4.0));
      channel.appendLine("Medium = between the two thresholds");
      channel.appendLine("Heavy  = score >= " + (getRouterConfig().threshold ?? 6.5));
    }
    channel.appendLine("\n--- Agent-mode routing (Language Model Provider) ---");
    channel.appendLine("Provider API available in this VS Code build : " + (providerApiAvailable ? "YES" : "NO"));
    channel.appendLine('"Copilot Pulse (Auto-Router)" model registered : ' + (providerRegistered ? "YES" : "NO"));
    if (!providerRegistered) {
      channel.appendLine("");
      channel.appendLine("To route models INSIDE Agent mode, run in a build that enables the proposal:");
      channel.appendLine("  • Press F5 in this project (Extension Development Host), OR");
      channel.appendLine("  • VS Code Insiders:  code-insiders --enable-proposed-api copilot-pulse.copilot-pulse-vscode");
      channel.appendLine("Then open the chat model picker and choose 'Copilot Pulse (Auto-Router)'.");
    }
    channel.show(true);
    vscode.window.showInformationMessage(
      copilotModels.length
        ? `Copilot Pulse: found ${copilotModels.length} model(s) — see the "Copilot Pulse" output panel.`
        : "Copilot Pulse: no Copilot models discovered yet (sign in / grant access)."
    );
  });
  context.subscriptions.push(showModelsCmd);

  // 7. Register the @copilotpulse chat participant (Copilot Pulse Agent).
  //    Scores the prompt, dynamically picks the optimal Copilot model tier,
  //    records the metric (live dashboard update), and executes tool calls.
  try {
    const participant = vscode.chat.createChatParticipant(
      "copilotPulse.copilotpulse",
      async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
      ): Promise<void> => {
        // Make sure we have the Copilot model list (first call may race activation).
        if (!copilotModels.length) {
          await discoverCopilotModels();
        }

        const cfg = getRouterConfig();

        // Stable id for this chat session so routing can stay sticky across
        // follow-up turns ("now fix it" must not collapse back to Light).
        const conversationId = getConversationId(chatContext);
        const history = (chatContext && (chatContext as any).history) || [];
        const allTools = (vscode.lm && Array.isArray(vscode.lm.tools)) ? vscode.lm.tools : [];

        // Attach the tool catalogue unless this is a high-confidence
        // informational question. Defaulting to "attach" matters: withholding
        // tools makes the agent reply "I'm unable to execute commands",
        // which is far worse than the extra tokens. Context-window pressure is
        // handled reactively by the overflow-recovery ladder instead.
        const cleanUserPrompt = (request.prompt || "").replace(/^@copilotpulse\s*/i, "").trim();
        const offerTools =
          allTools.length > 0 &&
          requiresTools(cleanUserPrompt, {
            conversationUsedTools: conversationStore.hasUsedTools(conversationId)
          });
        const agentTools = offerTools ? allTools : [];
        if (offerTools) {
          conversationStore.noteToolsOffered(conversationId);
        }

        // Route + record the metric -> this triggers a live dashboard refresh.
        const decision = proxyServer.recordChatMetric(request.prompt, cfg, 0, offerTools, {
          conversationId,
          turnDepth: Math.floor(history.length / 2) + 1,
          attachmentCount: (request as any).references?.length ?? 0,
          toolCount: agentTools.length
        });

        // Resolve the routed model to a concrete Copilot model; fall back to the
        // model selected in the chat picker if no match is found.
        const chosenModel = pickCopilotModel(decision.model) || request.model;
        const routedModelName =
          (chosenModel && (chosenModel.name || chosenModel.family || chosenModel.id)) ||
          decision.model.split("/").pop() ||
          decision.model;

        const reasonSuffix = decision.floorReason ? ` · _${decision.floorReason}_` : "";
        stream.markdown(
          `\`Copilot Pulse Agent\` → **${routedModelName}** · Score **${decision.score.toFixed(1)}/10** · Tier **${decision.tier}**${reasonSuffix}\n\n`
        );

        // Relay the conversation to the routed model with full multi-turn & tool calling support
        try {
          const messages = buildChatMessages(
            chatContext && (chatContext as any).history,
            request.prompt
          );
          await executeAgentTurn(chosenModel, messages, request, stream, token, {
            conversationId,
            band: decision.band ?? ModelTiering.bandOf(decision.model),
            availableModels: availableModelsCache,
            settings: getEscalationSettings(),
            tools: agentTools
          });
        } catch (err: any) {
          stream.markdown(
            `\n\n> ⚠️ **Copilot context error:** \`${err?.message || err}\`\n>\n> 💡 **Tip:** Start a new chat session (\`Cmd+N\`) and select **Copilot Pulse (Smart Router)** from the **Model Picker dropdown** to run with full native Agent Mode features (file edits & terminal tools).`
          );
        }
      }
    );
    participant.iconPath = new vscode.ThemeIcon("zap");
    context.subscriptions.push(participant);
  } catch (e) {
    console.error("[Copilot Pulse] Failed to register @copilotpulse chat participant:", e);
  }

  // 8. Register Language Model Chat Provider if proposal API is available
  if (vscode.lm && typeof (vscode.lm as any).registerLanguageModelChatProvider === "function") {
    try {
      const provider = createCopilotPulseModelProvider({
        getCopilotModels: () => copilotModels,
        getAvailableModels: () => availableModelsCache,
        getRouterConfig: getRouterConfig,
        discover: discoverCopilotModels,
        recordMetric: (prompt: string, config: RouterConfig) => proxyServer.recordChatMetric(prompt, config)
      });
      context.subscriptions.push(
        (vscode.lm as any).registerLanguageModelChatProvider("copilot-pulse-agent", provider),
        (vscode.lm as any).registerLanguageModelChatProvider("copilot-pulse", provider)
      );
      providerApiAvailable = true;
      providerRegistered = true;
      console.log("[Copilot Pulse] LanguageModelChatProvider registered for copilot-pulse and copilot-pulse-agent");
    } catch (e: any) {
      console.warn("[Copilot Pulse] Could not register LanguageModelChatProvider:", e?.message || e);
    }
  }

  // 9. Agent-mode routing is also handled via the Loopback Bridge!
  //    The local proxy (http://127.0.0.1:3456) intercepts custom-endpoint BYOK HTTP requests,
  //    routing all tool and function calls to the dynamically chosen LLM.
  console.log(
    "[Copilot Pulse] Loopback Bridge Active. Agent-mode routing via proxy at http://127.0.0.1:3456 → vscode.lm API."
  );
}

export function deactivate() {
  LocalProxyServer.getInstance().stop();
}
