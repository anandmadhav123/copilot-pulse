/**
 * Per-conversation routing memory.
 *
 * Fixes the biggest v1 accuracy bug: the score was computed from the latest
 * user message alone, so a follow-up like "now fix it" scored ~1.0
 * (QUICK_LOOKUP) and collapsed a deep architecture session down to the Light
 * tier. v2 remembers where the conversation has been and only lets the tier
 * decay gradually.
 *
 * Deliberately free of any `vscode` import so it stays unit-testable in Node.
 */

import { Band, BAND_ORDER } from "../proxy/ModelTiering";

/** Signature of a tool invocation, used to spot stuck loops. */
export interface ToolSignature {
  name: string;
  /** Stable hash of the tool arguments. */
  argsKey: string;
}

export interface ConversationRecord {
  conversationId: string;
  /** Highest complexity score seen so far in this conversation. */
  rollingScore: number;
  /** Band actually used for the most recent turn. */
  lastBand: Band | null;
  /** How many times we have escalated within this conversation. */
  escalations: number;
  /** Consecutive failed attempts (reset on a clean turn). */
  consecutiveFailures: number;
  /** Number of turns handled. */
  turnDepth: number;
  /** Recent tool signatures, newest last (bounded). */
  recentTools: ToolSignature[];
  /** Band floor forced by escalation — never route below this again. */
  floorBand: Band | null;
  /**
   * True once this conversation has been given the tool catalogue.
   * Keeps short follow-ups ("do it for me") agentic instead of silently
   * dropping back to a tool-less Q&A turn.
   */
  usedTools: boolean;
  updatedAt: number;
}

/** Max conversations kept in memory before the oldest are evicted. */
const MAX_CONVERSATIONS = 50;
/** How many tool signatures to remember per conversation. */
const MAX_TOOL_HISTORY = 8;
/**
 * How much complexity a conversation is allowed to shed in a single turn.
 * ~2.5 points is roughly one band, so a deep session degrades gracefully
 * instead of falling off a cliff.
 */
export const DEFAULT_STICKINESS_DECAY = 2.5;

export class ConversationStore {
  private records = new Map<string, ConversationRecord>();

  /** Fetches (or lazily creates) the record for a conversation. */
  public get(conversationId: string): ConversationRecord {
    let rec = this.records.get(conversationId);
    if (!rec) {
      rec = {
        conversationId,
        rollingScore: 0,
        lastBand: null,
        escalations: 0,
        consecutiveFailures: 0,
        turnDepth: 0,
        recentTools: [],
        floorBand: null,
        usedTools: false,
        updatedAt: Date.now()
      };
      this.records.set(conversationId, rec);
      this.evictIfNeeded();
    }
    rec.updatedAt = Date.now();
    return rec;
  }

  public peek(conversationId: string): ConversationRecord | undefined {
    return this.records.get(conversationId);
  }

  /**
   * Blends the raw score of the current turn with the conversation's history.
   *
   * The tier can rise instantly (a hard follow-up immediately gets a stronger
   * model) but may only fall by `decay` per turn.
   *
   * History presence is derived from `rollingScore` rather than `turnDepth`,
   * because routing happens *before* the turn is executed — keying off
   * turnDepth would leave stickiness permanently disabled for callers that
   * only route and never report an outcome.
   */
  public applyStickiness(
    conversationId: string,
    rawScore: number,
    decay: number = DEFAULT_STICKINESS_DECAY
  ): number {
    const rec = this.get(conversationId);
    const hasHistory = rec.rollingScore > 0;
    const floor = hasHistory ? Math.max(0, rec.rollingScore - decay) : 0;
    const effective = Math.max(rawScore, floor);
    // Store the blended value so the conversation decays one step per turn
    // instead of being pinned at its all-time peak forever.
    rec.rollingScore = effective;
    return effective;
  }

  /** Records the outcome of a turn. */
  public noteTurn(conversationId: string, band: Band, succeeded: boolean): void {
    const rec = this.get(conversationId);
    rec.turnDepth++;
    rec.lastBand = band;
    rec.consecutiveFailures = succeeded ? 0 : rec.consecutiveFailures + 1;
  }

  /** Records an escalation and raises the conversation's permanent band floor. */
  public noteEscalation(conversationId: string, newBand: Band): void {
    const rec = this.get(conversationId);
    rec.escalations++;
    if (!rec.floorBand || BAND_ORDER[newBand] > BAND_ORDER[rec.floorBand]) {
      rec.floorBand = newBand;
    }
  }

  /**
   * Appends a tool signature and reports how many times in a row this exact
   * call has now been made — the core "the agent is stuck" signal.
   */
  public noteToolCall(conversationId: string, sig: ToolSignature): number {
    const rec = this.get(conversationId);
    rec.recentTools.push(sig);
    if (rec.recentTools.length > MAX_TOOL_HISTORY) {
      rec.recentTools.shift();
    }

    let repeats = 0;
    for (let i = rec.recentTools.length - 1; i >= 0; i--) {
      const t = rec.recentTools[i];
      if (t.name === sig.name && t.argsKey === sig.argsKey) {
        repeats++;
      } else {
        break;
      }
    }
    return repeats;
  }

  /** Marks this conversation as agentic so follow-ups keep their tools. */
  public noteToolsOffered(conversationId: string): void {
    this.get(conversationId).usedTools = true;
  }

  /** True once the conversation has been given the tool catalogue. */
  public hasUsedTools(conversationId: string): boolean {
    return this.peek(conversationId)?.usedTools === true;
  }

  /** Forgets a conversation (e.g. the user started a new chat). */
  public reset(conversationId: string): void {
    this.records.delete(conversationId);
  }

  public clear(): void {
    this.records.clear();
  }

  private evictIfNeeded(): void {
    if (this.records.size <= MAX_CONVERSATIONS) return;
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, rec] of this.records) {
      if (rec.updatedAt < oldestAt) {
        oldestAt = rec.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.records.delete(oldestKey);
  }
}

/** Shared store used by the extension host. */
export const conversationStore = new ConversationStore();

/** Builds a compact, stable key for a tool-call argument object. */
export function toolArgsKey(input: any): string {
  try {
    if (input === undefined || input === null) return "";
    const json = typeof input === "string" ? input : JSON.stringify(input);
    if (json.length <= 200) return json;
    // Cheap stable digest for long payloads.
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      hash = (hash * 31 + json.charCodeAt(i)) | 0;
    }
    return `${json.length}:${hash}`;
  } catch {
    return "";
  }
}


