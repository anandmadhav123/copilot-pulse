import * as vscode from "vscode";
import { RouterConfig, RouterLogic } from "./RouterLogic";

/**
 * Dependencies the provider needs from the extension host.
 */
export interface ProviderDeps {
  /** Discovered Copilot LanguageModelChat objects. */
  getCopilotModels: () => any[];
  /** Model families/ids that feed the tiering engine. */
  getAvailableModels: () => string[];
  /** Current router configuration (thresholds, dynamic tiers, etc.). */
  getRouterConfig: () => RouterConfig;
  /** Force (re)discovery of Copilot models. */
  discover: () => Promise<void>;
  /** Record the routing decision to the dashboard. */
  recordMetric: (prompt: string, config: RouterConfig) => any;
}

/** Pull the most recent user text out of the agent-provided message list. */
function latestUserText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    // role: enum User is typically 1; also accept string "user".
    const role = m.role;
    const isUser = role === 1 || role === "user" || role === undefined;
    if (!isUser) continue;
    const text = extractText(m.content ?? m.value);
    if (text.trim().length > 0) return text;
  }
  // Fallback: last message with any text.
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = extractText(messages[i] && (messages[i].content ?? messages[i].value));
    if (t.trim().length > 0) return t;
  }
  return "";
}

/** Extract plain text from a message content (string | parts[]). */
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (typeof part === "string") {
        out += part;
      } else if (part && typeof part.value === "string") {
        out += part.value;
      } else if (part && typeof part.text === "string") {
        out += part.text;
      } else if (part && typeof part.content === "string") {
        out += part.content;
      } else if (part && Array.isArray(part.content)) {
        out += extractText(part.content);
      } else if (part && part.input) {
        out += typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      }
    }
    return out;
  }
  if (typeof content.value === "string") return content.value;
  if (typeof content.text === "string") return content.text;
  if (typeof content.content === "string") return content.content;
  if (Array.isArray(content.content)) return extractText(content.content);
  return "";
}

/** Rebuild agent messages as LanguageModelChatMessage objects for sendRequest, preserving all tool parts. */
function toSendRequestMessages(messages: any[]): any[] {
  const out: any[] = [];
  for (const m of messages || []) {
    if (!m) continue;

    // If m is already a native LanguageModelChatMessage instance, preserve it verbatim!
    if (vscode.LanguageModelChatMessage && m instanceof vscode.LanguageModelChatMessage) {
      out.push(m);
      continue;
    }

    const role = m.role;
    const isUser = role === 1 || role === "user" || role === undefined;
    const roleEnum = isUser
      ? ((vscode.LanguageModelChatMessageRole && vscode.LanguageModelChatMessageRole.User) || 1)
      : ((vscode.LanguageModelChatMessageRole && vscode.LanguageModelChatMessageRole.Assistant) || 2);

    // If m has structured content parts (text, tool calls, tool results)
    if (Array.isArray(m.content)) {
      if (vscode.LanguageModelChatMessage) {
        try {
          out.push(new vscode.LanguageModelChatMessage(roleEnum, m.content, m.name));
          continue;
        } catch {
          /* fallback to helper methods */
        }
      }
    }

    const rawContent = m.content ?? m.value ?? "";
    if (typeof rawContent === "string") {
      out.push(
        isUser
          ? vscode.LanguageModelChatMessage.User(rawContent)
          : vscode.LanguageModelChatMessage.Assistant(rawContent)
      );
    } else if (Array.isArray(rawContent)) {
      if (vscode.LanguageModelChatMessage) {
        try {
          out.push(new vscode.LanguageModelChatMessage(roleEnum, rawContent));
        } catch {
          const text = extractText(rawContent);
          out.push(isUser ? vscode.LanguageModelChatMessage.User(text) : vscode.LanguageModelChatMessage.Assistant(text));
        }
      } else {
        const text = extractText(rawContent);
        out.push(isUser ? vscode.LanguageModelChatMessage.User(text) : vscode.LanguageModelChatMessage.Assistant(text));
      }
    } else {
      const text = String(rawContent);
      out.push(isUser ? vscode.LanguageModelChatMessage.User(text) : vscode.LanguageModelChatMessage.Assistant(text));
    }
  }
  return out;
}

/**
 * Chooses the concrete Copilot model to serve a request, based on the existing
 * scoring + tiering logic.
 */
function route(deps: ProviderDeps, promptText: string, hasTools: boolean = false): { model: any; decision: any } {
  const cfg = deps.getRouterConfig();
  cfg.availableModels = deps.getAvailableModels();
  const decision = RouterLogic.routeDecision(promptText, cfg, hasTools);

  const copilotModels = deps.getCopilotModels();
  const target = (decision.model || "").toLowerCase();
  let model =
    copilotModels.find(
      (cm: any) =>
        (cm.family || "").toLowerCase() === target || (cm.id || "").toLowerCase() === target
    ) ||
    copilotModels.find((cm: any) => {
      const fam = (cm.family || "").toLowerCase();
      return fam.length > 0 && (target.includes(fam) || fam.includes(target));
    }) ||
    copilotModels[0];

  return { model, decision };
}

/**
 * Builds a VS Code Language Model Chat Provider that transparently routes each
 * request to the best-fit Copilot model, then relays the response (including
 * tool-call parts) verbatim — so Copilot's native agent keeps doing all the
 * tool-calling / actions. The plugin's only job is model selection.
 */
export function createCopilotPulseModelProvider(deps: ProviderDeps): any {
  const info = [
    {
      id: "copilot-pulse",
      name: "Copilot Pulse (Smart Router)",
      family: "copilot-pulse",
      version: "1.0.0",
      maxInputTokens: 4000000,
      maxOutputTokens: 8192,
      capabilities: { toolCalling: true, imageInput: true }
    },
    {
      id: "copilot-pulse-agent",
      name: "Copilot Pulse Agent",
      family: "copilot-pulse",
      version: "1.0.0",
      maxInputTokens: 4000000,
      maxOutputTokens: 8192,
      capabilities: { toolCalling: true, imageInput: true }
    },
    {
      id: "copilot-pulse-router",
      name: "Copilot Pulse Router",
      family: "copilot-pulse",
      version: "1.0.0",
      maxInputTokens: 4000000,
      maxOutputTokens: 8192,
      capabilities: { toolCalling: true, imageInput: true }
    }
  ];

  async function provideResponse(
    _model: any,
    messages: any[],
    options: any,
    progress: any,
    token: any
  ): Promise<void> {
    const copilotModels = deps.getCopilotModels();
    if (!copilotModels.length) {
      await deps.discover();
    }

    const hasTools = !!(options && options.tools && options.tools.length > 0);
    const promptText = latestUserText(messages);
    const { model, decision } = route(deps, promptText, hasTools);

    // Record for the dashboard (Metrics & Savings updates in agent mode too).
    try {
      deps.recordMetric(promptText, deps.getRouterConfig());
    } catch {
      /* non-fatal */
    }

    if (!model) {
      const msg =
        "Copilot Pulse: no Copilot models available to route to. Sign in to GitHub Copilot and grant language-model access.";
      reportText(progress, msg);
      return;
    }

    // Forward the request (messages + tools) to the routed Copilot model and
    // relay every response part back to the agent unchanged.
    const forwardOptions: any = {};
    if (options) {
      if (options.tools) forwardOptions.tools = options.tools;
      if (options.toolMode !== undefined) forwardOptions.toolMode = options.toolMode;
      if (options.justification) forwardOptions.justification = options.justification;
      if (options.modelOptions) forwardOptions.modelOptions = options.modelOptions;
    }

    const sendMessages = toSendRequestMessages(messages);
    let response: any;

    try {
      response = await model.sendRequest(sendMessages, forwardOptions, token);
    } catch (err: any) {
      console.warn(`[Copilot Pulse] Primary sendRequest failed on ${model.name || model.id}:`, err?.message || err);
      // Fallback 1: retry with original messages (if conversion differed)
      try {
        response = await model.sendRequest(messages, forwardOptions, token);
      } catch (innerErr: any) {
        console.warn("[Copilot Pulse] Fallback 1 failed:", innerErr?.message || innerErr);
        // Fallback 2: retry without forwardOptions (for models without toolMode)
        try {
          response = await model.sendRequest(sendMessages, {}, token);
        } catch (fatalErr: any) {
          console.error("[Copilot Pulse] All model.sendRequest attempts failed:", fatalErr?.message || fatalErr);
          reportText(progress, `\n\n> ⚠️ *Copilot Pulse Provider Error:* ${err?.message || err}\n`);
          // Throw so VS Code marks the turn as failed and offers a retry.
          // Returning normally makes the agent think the task finished.
          throw fatalErr;
        }
      }
    }

    console.log(
      `[Copilot Pulse] Provider routed → ${model.name || model.family || model.id} ` +
        `(score ${decision.score.toFixed(1)}, ${decision.tier}, tools=${hasTools})`
    );

    if (response && response.stream && typeof response.stream[Symbol.asyncIterator] === "function") {
      let reported = 0;
      try {
        for await (const part of response.stream) {
          if (token && token.isCancellationRequested) return;
          progress.report(part); // text parts AND tool-call parts relayed as-is
          reported++;
        }
      } catch (streamErr: any) {
        console.error("[Copilot Pulse] Error iterating response stream:", streamErr);
        if (token && token.isCancellationRequested) return;

        // Nothing relayed yet → transparently retry once so a transient
        // upstream hiccup doesn't kill the agent run.
        if (reported === 0) {
          try {
            const retry = await model.sendRequest(sendMessages, forwardOptions, token);
            for await (const part of retry.stream) {
              if (token && token.isCancellationRequested) return;
              progress.report(part);
              reported++;
            }
            return;
          } catch (retryErr: any) {
            console.error("[Copilot Pulse] Stream retry failed:", retryErr?.message || retryErr);
            throw retryErr;
          }
        }

        // Partial content was already relayed. Surface the interruption to the
        // user instead of ending the turn silently mid-sentence — a silent end
        // makes the agent believe the task is complete and it stops.
        reportText(
          progress,
          `\n\n> ⚠️ *Copilot Pulse: the response stream was interrupted (${streamErr?.message || streamErr}). ` +
            `Say "continue" to resume.*\n`
        );
      }
    } else if (response && response.text) {
      try {
        for await (const fragment of response.text) {
          if (token && token.isCancellationRequested) return;
          reportText(progress, fragment);
        }
      } catch (textErr: any) {
        console.error("[Copilot Pulse] Error iterating response text:", textErr);
        if (token && token.isCancellationRequested) return;
        reportText(
          progress,
          `\n\n> ⚠️ *Copilot Pulse: the response stream was interrupted (${textErr?.message || textErr}). ` +
            `Say "continue" to resume.*\n`
        );
      }
    }
  }

  function reportText(progress: any, text: string): void {
    try {
      progress.report(new vscode.LanguageModelTextPart(text));
    } catch {
      // Older shape: progress may accept a plain object.
      try {
        progress.report({ value: text });
      } catch {
        /* ignore */
      }
    }
  }

  async function provideTokenCount(_model: any, text: any, token: any): Promise<number> {
    // Returning 0 made VS Code believe the context was empty, so it kept
    // packing more history into the request until the upstream rejected it and
    // the run died mid-task. A ~4-chars-per-token estimate is far safer.
    try {
      const raw = typeof text === "string" ? text : extractText(text);
      return Math.max(1, Math.ceil((raw || "").length / 4));
    } catch {
      return 1;
    }
  }

  // Support both the current and older method names via aliases.
  return {
    // Newer API
    provideLanguageModelChatInformation: (_opts: any, _token: any) => info,
    provideLanguageModelChatResponse: provideResponse,
    provideTokenCount,
    // Older API aliases (harmless if unused)
    prepareLanguageModelChat: (_opts: any, _token: any) => info,
    provideLanguageModelResponse: provideResponse
  };
}

