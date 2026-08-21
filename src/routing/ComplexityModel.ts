/**
 * Copilot Pulse routing v2 — complexity scoring.
 *
 * Turns a `PromptFeatures` vector into a 0..10 complexity score plus a
 * per-signal breakdown, so every routing decision can be *explained* in the
 * dashboard instead of being an opaque number.
 */

import { PromptFeatures } from "./PromptFeatures";

export interface ScoreBreakdown {
  /** Final 0..10 complexity score. */
  total: number;
  /** Individual contributions (already weighted), for display/debugging. */
  signals: {
    keyword: number;
    intent: number;
    code: number;
    structure: number;
    context: number;
    tools: number;
    recovery: number;
  };
  /** Human-readable notes explaining notable boosts. */
  notes: string[];
}

/**
 * Base weights for the three original signals.
 *
 * These deliberately match v1 exactly (0.3 / 0.5 / 0.2), which makes v2 a
 * strict *superset* of v1: identical prompts score identically, and the new
 * signals only ever act as bounded additive modifiers on top. That keeps the
 * upgrade explainable and any behaviour change attributable to a named signal.
 */
const W_KEYWORD = 0.3;
const W_INTENT = 0.5;
const W_CODE = 0.2;

/** Maximum additive contribution of each new signal group. */
const MAX_STRUCTURE_BOOST = 1.5;
const MAX_CONTEXT_BOOST = 1.5;
const MAX_TOOL_BOOST = 1.5;
const MAX_RECOVERY_BOOST = 2.5;

/** Code-awareness sub-score (0..10), from fences, traces and diffs. */
function computeCodeScore(f: PromptFeatures): number {
  let score = 0;
  if (f.codeBlockRatio > 0) score += 2.0;
  if (f.hasStackTrace) score += 3.0;
  if (f.hasDiff) score += 2.0;
  if (f.codeBlockRatio > 0.3) score += 1.0;
  if (f.codeBlockRatio > 0.6) score += 1.0;
  return Math.min(10, score);
}

/**
 * Structural complexity: many requirements or a long, multi-part prompt means
 * more planning, which lighter models handle poorly.
 */
function computeStructureBoost(f: PromptFeatures, notes: string[]): number {
  let boost = 0;
  if (f.requirementCount >= 3) {
    boost += 0.6;
    notes.push(`${f.requirementCount} distinct requirements`);
  }
  if (f.requirementCount >= 6) boost += 0.5;
  if (f.wordCount >= 150) {
    boost += 0.4;
    notes.push("long multi-part prompt");
  }
  if (f.wordCount >= 400) boost += 0.4;
  return Math.min(MAX_STRUCTURE_BOOST, boost);
}

/**
 * Context weight: attached files and cross-file references demand a model
 * that can hold more of the picture at once.
 */
function computeContextBoost(f: PromptFeatures, notes: string[]): number {
  let boost = 0;
  if (f.attachmentCount >= 1) boost += 0.3;
  if (f.attachmentCount >= 3) {
    boost += 0.5;
    notes.push(`${f.attachmentCount} attached files`);
  }
  if (f.attachmentBytes >= 20_000) boost += 0.4;
  if (f.attachmentBytes >= 80_000) boost += 0.4;
  if (f.hasMultiFileRefs) {
    boost += 0.4;
    notes.push("cross-file reasoning");
  }
  return Math.min(MAX_CONTEXT_BOOST, boost);
}

/**
 * Tool-awareness.
 *
 * v1 did `effectiveScore = max(score, threshold)` whenever tools were present,
 * which forced **every Agent Mode request to the Heavy tier** — the savings
 * engine saved nothing exactly where it was used most.
 *
 * v2 instead applies a bounded boost that grows with the size of the tool
 * surface. The hard "never use a Light model for tool calling" rule is
 * enforced separately as a *band floor* (see RouterLogic), which keeps simple
 * agent turns on Medium instead of promoting them all to Heavy.
 */
function computeToolBoost(f: PromptFeatures, notes: string[]): number {
  if (f.toolCount <= 0) return 0;
  let boost = 0.4;
  if (f.toolCount >= 8) boost += 0.4;
  if (f.toolCount >= 20) boost += 0.4;
  if (f.toolCount >= 40) boost += 0.3;
  notes.push(`agent mode (${f.toolCount} tools)`);
  return Math.min(MAX_TOOL_BOOST, boost);
}

/**
 * Recovery pressure: prior failures and explicit user dissatisfaction are the
 * strongest evidence that the previous (cheaper) choice was wrong.
 */
function computeRecoveryBoost(f: PromptFeatures, notes: string[]): number {
  let boost = 0;
  if (f.priorFailures > 0) {
    boost += Math.min(1.5, f.priorFailures * 0.75);
    notes.push(`${f.priorFailures} prior failure(s)`);
  }
  if (f.dissatisfaction) {
    boost += 1.5;
    notes.push("user reported the last answer did not work");
  }
  return Math.min(MAX_RECOVERY_BOOST, boost);
}

/** Computes the full explainable score for a feature vector. */
export function scoreFeatures(f: PromptFeatures): ScoreBreakdown {
  const notes: string[] = [];

  const codeScore = computeCodeScore(f);

  const keyword = f.keywordScore * W_KEYWORD;
  const intent = f.intentScore * W_INTENT;
  const code = codeScore * W_CODE;
  const structure = computeStructureBoost(f, notes);
  const context = computeContextBoost(f, notes);
  const tools = computeToolBoost(f, notes);
  const recovery = computeRecoveryBoost(f, notes);

  const total = Math.max(
    0,
    Math.min(10, keyword + intent + code + structure + context + tools + recovery)
  );

  return {
    total,
    signals: { keyword, intent, code, structure, context, tools, recovery },
    notes
  };
}


