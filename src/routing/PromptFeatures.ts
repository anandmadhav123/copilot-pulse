/**
 * Deterministic prompt feature extraction for Copilot Pulse routing v2.
 *
 * This module is intentionally free of any `vscode` import so it can be unit
 * tested in plain Node (like the rest of the proxy layer).
 *
 * It owns the keyword/intent taxonomies that used to live inside RouterLogic,
 * plus the new structural + conversational signals that v1 ignored entirely.
 */

export interface KeywordCategory {
  name: string;
  weight: number;
  keywords: string[];
}

export interface TaskPattern {
  type: string;
  patterns: RegExp[];
  baseScore: number;
  /**
   * Explicit tie-break priority (higher wins).
   *
   * v1 resolved "same number of regexes matched" by array position, which made
   * ARCHITECTURE (first in the list) win every 1-vs-1 tie. Priority makes the
   * ordering intentional instead of accidental.
   */
  priority: number;
}

/**
 * Everything the router knows about the *situation* a prompt arrives in,
 * beyond the prompt text itself.
 */
export interface RoutingContext {
  /** Stable id for the chat session, used for conversation stickiness. */
  conversationId?: string;
  /** How many turns deep the conversation is (1 = first turn). */
  turnDepth?: number;
  /** Number of files/context items attached to the request. */
  attachmentCount?: number;
  /** Approximate total size of attached context, in bytes. */
  attachmentBytes?: number;
  /** Number of tool definitions supplied with the request (Agent Mode). */
  toolCount?: number;
  /** Consecutive failed attempts already observed in this conversation. */
  priorFailures?: number;
}

export interface PromptFeatures {
  charLength: number;
  wordCount: number;
  /** Distinct requirements detected ("and then", numbered lists, bullets). */
  requirementCount: number;
  questionCount: number;
  /** Fraction of the prompt occupied by fenced code blocks (0..1). */
  codeBlockRatio: number;
  hasStackTrace: boolean;
  hasDiff: boolean;
  /** Mentions several concrete file paths → cross-file reasoning. */
  hasMultiFileRefs: boolean;
  attachmentCount: number;
  attachmentBytes: number;
  toolCount: number;
  turnDepth: number;
  priorFailures: number;
  /** User is signalling the previous answer was wrong / didn't work. */
  dissatisfaction: boolean;
  /** Length-normalised keyword strength (0..10). */
  keywordScore: number;
  intentType: string;
  intentScore: number;
}

export const KEYWORD_CATEGORIES: KeywordCategory[] = [
  { name: "reasoning_depth", weight: 2.0, keywords: ["architect", "design", "trade-off", "tradeoff", "compare", "evaluate", "scale", "scalable", "distributed", "microservice", "pattern", "principles", "best practice"] },
  { name: "code_complexity", weight: 1.5, keywords: ["refactor", "debug", "optimize", "migrate", "implement", "performance", "memory leak", "race condition", "deadlock", "concurrency", "async", "threading", "benchmark"] },
  { name: "mathematical", weight: 1.8, keywords: ["algorithm", "complexity", "o(n)", "o(log", "proof", "calculate", "recursive", "dynamic programming", "graph theory", "binary search", "sorting", "big-o", "mathematical", "equation"] },
  { name: "knowledge", weight: 0.5, keywords: ["explain", "summarize", "what is", "how does", "why does", "definition", "meaning", "overview", "introduction"] },
  { name: "creative", weight: 0.3, keywords: ["brainstorm", "suggest", "creative", "write a story", "poem", "blog post", "marketing", "slogan"] }
];

export const TASK_PATTERNS: TaskPattern[] = [
  { type: "ARCHITECTURE", priority: 90, baseScore: 9.0, patterns: [/\b(architect|design\s+a\s+system|system\s+design|microservice|distributed|scalab)/i, /\b(infrastructure|deployment\s+strategy|cloud\s+architecture|data\s+pipeline)/i, /\b(design\s+pattern|event[-]driven|message\s+queue|load\s+balanc)/i] },
  { type: "MATH_LOGIC", priority: 80, baseScore: 8.0, patterns: [/\b(algorithm|data\s+structure|time\s+complexity|space\s+complexity|big[-]?o)/i, /\b(dynamic\s+programming|greedy|backtrack|graph\s+traversal|binary\s+search)/i] },
  { type: "CODE_REFACTORING", priority: 75, baseScore: 8.0, patterns: [/\b(refactor|clean\s+up|restructur|improve\s+(this|the|my)\s+code|code\s+review)/i, /\b(technical\s+debt|code\s+smell|solid\s+principle|dry\s+principle)/i] },
  { type: "CODE_DEBUGGING", priority: 70, baseScore: 7.0, patterns: [/\b(debug|fix\s+(this|the|my)|not\s+working|error|bug|issue|crash|exception)/i, /\b(stack\s*trace|traceback|segfault|undefined\s+is\s+not|cannot\s+read\s+propert)/i] },
  { type: "CODE_GENERATION", priority: 60, baseScore: 6.0, patterns: [/\b(write\s+(a|me|the)\s+(function|class|component|script|program|api|endpoint))/i, /\b(create\s+(a|me|the)\s+(function|class|component|module|service|hook))/i, /\b(implement\s+(a|the)|build\s+(a|me|the)\s+(function|class|app|feature))/i] },
  { type: "EXPLANATION", priority: 40, baseScore: 4.0, patterns: [/\b(explain|describe|what\s+is|what\s+are|how\s+does|how\s+do|why\s+does|why\s+do)/i, /\b(tell\s+me\s+about|walk\s+me\s+through|break\s+down|elaborate|clarify)/i] },
  { type: "CREATIVE_WRITING", priority: 30, baseScore: 3.0, patterns: [/\b(write\s+(a|me)(\s+\w+)?\s+(story|poem|essay|blog|article|email|letter|speech))/i, /\b(brainstorm|creative|marketing\s+copy|tagline|slogan|draft\s+a)/i] },
  { type: "QUICK_LOOKUP", priority: 10, baseScore: 1.0, patterns: [/^(what|how|when|where|who|which|can\s+you)\s+.{5,50}\??$/i, /\b(command\s+(to|for)|shortcut|syntax\s+for|how\s+to\s+\w+\s+in)/i] }
];

/**
 * Phrases that mean "your last answer was wrong / didn't work".
 * Cheap to detect and a very high-precision escalation signal.
 */
const DISSATISFACTION_PATTERNS: RegExp[] = [
  /\b(still|again)\s+(broken|failing|fails|not\s+working|the\s+same)/i,
  /\b(that'?s|this\s+is)\s+(wrong|incorrect|not\s+right|not\s+what)/i,
  /\b(didn'?t|does\s*n'?t|did\s+not)\s+(work|help|fix)/i,
  /\b(try\s+again|retry|another\s+approach|different\s+approach)/i,
  /\b(you|it)\s+(broke|messed\s+up|missed)/i,
  /\bsame\s+error\b/i,
  /\bnot\s+fixed\b/i
];

const STACK_TRACE_PATTERNS: RegExp[] = [
  /\bat\s+[\w.$]+\([^)]*:\d+:\d+\)/,          // JS/Java frames
  /Traceback \(most recent call last\)/,       // Python
  /File ".*", line \d+/,                       // Python
  /\bCaused by:\s+[\w.]+(Exception|Error)/,    // Java
  /^\s*at\s+[\w.$<>]+\(.*\)$/m,                // generic JVM frame
  /\b[\w.]+(Exception|Error):\s/                // ExceptionName: message
];

/** Detects unified diffs / patch blocks. */
const DIFF_PATTERN = /^(diff --git|@@ -\d+,?\d* \+\d+,?\d* @@|[+-]{3} [ab]\/)/m;

/** Rough file-path detector (e.g. src/foo/Bar.ts, ./x.py). */
const FILE_PATH_PATTERN = /\b[\w./-]+\.(ts|tsx|js|jsx|py|java|kt|go|rs|rb|cs|cpp|c|h|php|swift|scala|sh|yml|yaml|json|xml|gradle|kts)\b/g;

/**
 * Prompts that imply the model must *act* on the workspace.
 */
const ACTION_INTENT_PATTERNS: RegExp[] = [
  /\b(create|add|write|generate|implement|build|make|scaffold|set\s+up)\b/i,
  /\b(fix|debug|repair|resolve|patch|correct|troubleshoot)\b/i,
  /\b(refactor|rename|move|delete|remove|replace|update|modify|edit|change)\b/i,
  /\b(run|execute|install|compile|test|deploy|start|launch|package)\b/i,
  /\b(search|find|look\s+up|grep|locate)\b[\s\S]{0,40}\b(file|code|workspace|project|repo)/i,
  /\b(read|open|show\s+me|list)\b[\s\S]{0,40}\b(file|folder|directory|workspace|project)/i,
  /\b(this|my|the)\s+(file|project|workspace|repo|repository|codebase)\b/i
];

/**
 * Short continuations and affirmatives. These carry no action verb of their
 * own but inherit the intent of the conversation — "do it for me", "go ahead",
 * "yes please" absolutely require tools.
 */
const CONTINUATION_PATTERNS: RegExp[] = [
  /^\s*(do|go)\s+(it|ahead|on)\b/i,
  /^\s*(yes|yep|yeah|ok|okay|sure|please)\b/i,
  /^\s*(continue|proceed|carry\s+on|keep\s+going|next)\b/i,
  /\bdo\s+it\s+(for\s+me|now|please)\b/i,
  /\b(apply|implement)\s+(it|that|those|these|the\s+changes)\b/i,
  /^\s*(make|do)\s+(it|that)\b/i,
  /\bfor\s+me\b/i
];

/**
 * High-confidence *informational* questions — the only case where withholding
 * the tool catalogue is safe.
 */
const PURE_QUESTION_PATTERNS: RegExp[] = [
  /^\s*(what|why|when|who|which)\b[\s\S]{0,120}\??\s*$/i,
  /^\s*how\s+(does|do|did|is|are|was|were|can|would|should)\b[\s\S]{0,120}\??\s*$/i,
  /^\s*(explain|describe|summari[sz]e|define|compare)\b/i,
  /^\s*tell\s+me\s+about\b/i,
  /^\s*what'?s\s+the\s+difference\b/i
];

/**
 * Decides whether the tool catalogue should be sent to the model.
 *
 * **This defaults to TRUE, deliberately.** The two failure modes are wildly
 * asymmetric:
 *
 *  - Attaching tools unnecessarily costs a few extra tokens.
 *  - Withholding them *breaks agent mode outright* — the model replies
 *    "I'm unable to execute commands directly on your machine" and the user
 *    gets nothing.
 *
 * So we only withhold for a high-confidence informational question in a
 * conversation that has never used tools. Everything else — including short
 * continuations like "do it for me" and anything ambiguous — gets tools.
 *
 * Context-window pressure is handled *reactively* by the overflow-recovery
 * ladder (which drops tools as a late step), not by guessing up front.
 */
export function requiresTools(
  text: string,
  ctx: { conversationUsedTools?: boolean } = {}
): boolean {
  const safe = (text || "").trim();
  if (safe.length === 0) return true;

  // Explicit action → always.
  if (ACTION_INTENT_PATTERNS.some((re) => re.test(safe))) return true;

  // "do it for me", "go ahead", "yes please" → inherits agentic intent.
  if (CONTINUATION_PATTERNS.some((re) => re.test(safe))) return true;

  // Once a conversation has gone agentic, keep the tools available.
  if (ctx.conversationUsedTools) return true;

  // Only now is it safe to withhold: a clear informational question.
  if (PURE_QUESTION_PATTERNS.some((re) => re.test(safe))) return false;

  // Ambiguous → attach. Breaking the agent is worse than a few extra tokens.
  return true;
}

/** Returns true if the text looks like the user is unhappy with the last answer. */
export function detectDissatisfaction(text: string): boolean {
  if (!text) return false;
  return DISSATISFACTION_PATTERNS.some((re) => re.test(text));
}

/**
 * Picks the best-matching task type.
 *
 * Selection order: (1) most regexes matched, (2) highest explicit priority.
 */
export function detectTaskType(text: string): { type: string; baseScore: number } {
  if (!text || text.trim().length === 0) {
    return { type: "GENERAL", baseScore: 2.0 };
  }

  let bestMatches = 0;
  let bestPriority = -1;
  let best: TaskPattern | null = null;

  for (const pattern of TASK_PATTERNS) {
    let matches = 0;
    for (const regex of pattern.patterns) {
      if (regex.test(text)) matches++;
    }
    if (matches === 0) continue;

    if (matches > bestMatches || (matches === bestMatches && pattern.priority > bestPriority)) {
      bestMatches = matches;
      bestPriority = pattern.priority;
      best = pattern;
    }
  }

  if (!best) {
    // No pattern matched at all — treat as a generic coding request.
    return { type: "CODE_GENERATION", baseScore: 2.0 };
  }
  return { type: best.type, baseScore: best.baseScore };
}

/**
 * Keyword strength, bounded per category.
 *
 * v1 summed raw `includes()` hits with no ceiling, so a prompt that repeated
 * one topic could run the score away on its own. v2 caps each category's
 * contribution instead.
 *
 * Note we deliberately do NOT divide by prompt length: a longer, more detailed
 * request is generally *more* complex, not less, so length-normalising here
 * would push exactly the wrong way. Verbosity is bounded by the per-category
 * cap and the overall 0..10 clamp.
 */
export function computeKeywordScore(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();

  let total = 0;
  for (const category of KEYWORD_CATEGORIES) {
    let hits = 0;
    for (const kw of category.keywords) {
      if (lower.includes(kw)) hits++;
    }
    // Cap each category so a single topic can't dominate the blend.
    total += Math.min(hits, 4) * category.weight;
  }
  return Math.min(10, total);
}

/** Counts distinct requirements ("and then", numbered lists, bullets). */
export function countRequirements(text: string): number {
  if (!text) return 0;
  let count = 0;
  count += (text.match(/^\s*\d+[.)]\s+/gm) || []).length;   // 1. 2. 3.
  count += (text.match(/^\s*[-*•]\s+/gm) || []).length;      // bullets
  count += (text.match(/\b(and\s+then|after\s+that|also|additionally|finally|next,)\b/gi) || []).length;
  return count;
}

/** Extracts the full deterministic feature vector for a prompt. */
export function extractFeatures(text: string, ctx: RoutingContext = {}): PromptFeatures {
  const safe = text || "";
  const codeBlocks: string[] = safe.match(/```[\s\S]*?```/g) || [];
  const codeChars = codeBlocks.reduce((sum, block) => sum + block.length, 0);
  const filePaths = safe.match(FILE_PATH_PATTERN) || [];
  const uniquePaths = new Set(filePaths.map((p) => p.toLowerCase()));
  const intent = detectTaskType(safe);

  return {
    charLength: safe.length,
    wordCount: (safe.match(/\S+/g) || []).length,
    requirementCount: countRequirements(safe),
    questionCount: (safe.match(/\?/g) || []).length,
    codeBlockRatio: safe.length > 0 ? codeChars / safe.length : 0,
    hasStackTrace: STACK_TRACE_PATTERNS.some((re) => re.test(safe)),
    hasDiff: DIFF_PATTERN.test(safe),
    hasMultiFileRefs: uniquePaths.size >= 2,
    attachmentCount: ctx.attachmentCount ?? 0,
    attachmentBytes: ctx.attachmentBytes ?? 0,
    toolCount: ctx.toolCount ?? 0,
    turnDepth: ctx.turnDepth ?? 1,
    priorFailures: ctx.priorFailures ?? 0,
    dissatisfaction: detectDissatisfaction(safe),
    keywordScore: computeKeywordScore(safe),
    intentType: intent.type,
    intentScore: intent.baseScore
  };
}


