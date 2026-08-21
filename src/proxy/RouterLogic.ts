import { ModelTiering, Band, BAND_ORDER } from "./ModelTiering";
import { extractFeatures, detectTaskType as detectTaskTypeV2, RoutingContext } from "../routing/PromptFeatures";
import { scoreFeatures, ScoreBreakdown } from "../routing/ComplexityModel";
import { conversationStore, DEFAULT_STICKINESS_DECAY } from "../routing/ConversationState";

export interface KeywordCategory {
  name: string;
  weight: number;
  keywords: string[];
}

export interface TaskPattern {
  type: string;
  patterns: RegExp[];
  baseScore: number;
}

export interface Decision {
  model: string;
  score: number;
  tier: string;
  savings: boolean;
  /** v2 only: per-signal explanation of the score. */
  breakdown?: ScoreBreakdown;
  /** v2 only: the band that was ultimately selected. */
  band?: Band;
  /** v2 only: why the band was raised above the raw score, if it was. */
  floorReason?: string;
}

export interface RouterConfig {
  baseUrl?: string;
  apiKey?: string;
  cheapModel?: string;
  strongModel?: string;
  useDynamicTiers?: boolean;
  threshold?: number;
  lowThreshold?: number;
  availableModels?: string[];
  /** Enables the v2 context-aware scoring engine (default: true). */
  routingV2?: boolean;
  /** How much complexity a conversation may shed per turn. */
  stickiness?: number;
}

const KEYWORD_CATEGORIES: KeywordCategory[] = [
  { name: "reasoning_depth", weight: 2.0, keywords: ["architect", "design", "trade-off", "tradeoff", "compare", "evaluate", "scale", "scalable", "distributed", "microservice", "pattern", "principles", "best practice"] },
  { name: "code_complexity", weight: 1.5, keywords: ["refactor", "debug", "optimize", "migrate", "implement", "performance", "memory leak", "race condition", "deadlock", "concurrency", "async", "threading", "benchmark"] },
  { name: "mathematical", weight: 1.8, keywords: ["algorithm", "complexity", "o(n)", "o(log", "proof", "calculate", "recursive", "dynamic programming", "graph theory", "binary search", "sorting", "big-o", "mathematical", "equation"] },
  { name: "knowledge", weight: 0.5, keywords: ["explain", "summarize", "what is", "how does", "why does", "definition", "meaning", "overview", "introduction"] },
  { name: "creative", weight: 0.3, keywords: ["brainstorm", "suggest", "creative", "write a story", "poem", "blog post", "marketing", "slogan"] }
];

const TASK_PATTERNS: TaskPattern[] = [
  { type: "ARCHITECTURE", patterns: [/\b(architect|design\s+a\s+system|system\s+design|microservice|distributed|scalab)/i, /\b(infrastructure|deployment\s+strategy|cloud\s+architecture|data\s+pipeline)/i, /\b(design\s+pattern|event[-]driven|message\s+queue|load\s+balanc)/i], baseScore: 9.0 },
  { type: "CODE_REFACTORING", patterns: [/\b(refactor|clean\s+up|restructur|improve\s+(this|the|my)\s+code|code\s+review)/i, /\b(technical\s+debt|code\s+smell|solid\s+principle|dry\s+principle)/i], baseScore: 8.0 },
  { type: "CODE_DEBUGGING", patterns: [/\b(debug|fix\s+(this|the|my)|not\s+working|error|bug|issue|crash|exception)/i, /\b(stack\s*trace|traceback|segfault|undefined\s+is\s+not|cannot\s+read\s+propert)/i], baseScore: 7.0 },
  { type: "MATH_LOGIC", patterns: [/\b(algorithm|data\s+structure|time\s+complexity|space\s+complexity|big[-]?o)/i, /\b(dynamic\s+programming|greedy|backtrack|graph\s+traversal|binary\s+search)/i], baseScore: 8.0 },
  { type: "CODE_GENERATION", patterns: [/\b(write\s+(a|me|the)\s+(function|class|component|script|program|api|endpoint))/i, /\b(create\s+(a|me|the)\s+(function|class|component|module|service|hook))/i, /\b(implement\s+(a|the)|build\s+(a|me|the)\s+(function|class|app|feature))/i], baseScore: 6.0 },
  { type: "EXPLANATION", patterns: [/\b(explain|describe|what\s+is|what\s+are|how\s+does|how\s+do|why\s+does|why\s+do)/i, /\b(tell\s+me\s+about|walk\s+me\s+through|break\s+down|elaborate|clarify)/i], baseScore: 4.0 },
  { type: "CREATIVE_WRITING", patterns: [/\b(write\s+(a|me)(\s+\w+)?\s+(story|poem|essay|blog|article|email|letter|speech))/i, /\b(brainstorm|creative|marketing\s+copy|tagline|slogan|draft\s+a)/i], baseScore: 3.0 },
  { type: "QUICK_LOOKUP", patterns: [/^(what|how|when|where|who|which|can\s+you)\s+.{5,50}\??$/i, /\b(command\s+(to|for)|shortcut|syntax\s+for|how\s+to\s+\w+\s+in)/i], baseScore: 1.0 }
];

export class RouterLogic {
  /**
   * Detects the task type of a prompt.
   *
   * Delegates to the v2 resolver, which breaks "same number of regexes
   * matched" ties by explicit priority instead of array position (v1 let
   * ARCHITECTURE win every tie purely because it was declared first).
   */
  public static detectTaskType(text: string): string {
    if (!text) return "GENERAL";
    return detectTaskTypeV2(text).type;
  }

  public static calculateScore(text: string): number {
    if (!text || text.trim().length === 0) return 0.0;

    // 1. Keyword Score
    const lowerText = text.toLowerCase();
    let keywordScore = 0.0;
    for (const category of KEYWORD_CATEGORIES) {
      let hits = 0;
      for (const kw of category.keywords) {
        if (lowerText.includes(kw)) hits++;
      }
      keywordScore += hits * category.weight;
    }
    keywordScore = Math.min(10.0, keywordScore);

    // 2. Task Intent Score
    let intentScore = 2.0; // default
    let bestMatchCount = 0;
    for (const pattern of TASK_PATTERNS) {
      let matchCount = 0;
      for (const regex of pattern.patterns) {
        if (regex.test(text)) matchCount++;
      }
      if (matchCount > bestMatchCount) {
        bestMatchCount = matchCount;
        intentScore = pattern.baseScore;
      }
    }

    // 3. Code Awareness Score
    let codeScore = 0.0;
    if (/```[\s\S]*?```/.test(text)) codeScore += 2.0;
    if (/at\s+\w+.*\(: \d+:\d+\)|Traceback|File ".*", line \d+/.test(text)) codeScore += 3.0;

    const matches: string[] = text.match(/```[\s\S]*?```/g) || [];
    const codeChars = matches.reduce((sum, match) => sum + match.length, 0);
    const codeRatio = text.length > 0 ? codeChars / text.length : 0.0;

    if (codeRatio > 0.3) codeScore += 1.0;
    if (codeRatio > 0.6) codeScore += 1.0;
    codeScore = Math.min(10.0, codeScore);

    // Final weighted calculation
    return (keywordScore * 0.3) + (intentScore * 0.5) + (codeScore * 0.2);
  }

  /**
   * v2 scoring: context-aware complexity with an explainable breakdown.
   * Falls back to the v1 blend when `routingV2` is explicitly disabled.
   */
  public static calculateScoreV2(prompt: string, ctx: RoutingContext = {}): ScoreBreakdown {
    return scoreFeatures(extractFeatures(prompt, ctx));
  }

  public static routeDecision(
    prompt: string,
    config?: RouterConfig,
    hasTools: boolean = false,
    ctx: RoutingContext = {}
  ): Decision {
    const cheapModel = config?.cheapModel || "openai/gpt-4o-mini";
    const strongModel = config?.strongModel || "openai/gpt-4o";
    const threshold = config?.threshold ?? 6.5;
    const lowThreshold = config?.lowThreshold ?? 4.0;
    const useDynamicTiers = config?.useDynamicTiers ?? true;
    const availableModels = config?.availableModels || [];
    const useV2 = config?.routingV2 ?? true;

    let score: number;
    let breakdown: ScoreBreakdown | undefined;

    if (useV2) {
      // Tool count feeds the score as a bounded boost rather than a hard
      // override (see ComplexityModel.computeToolBoost).
      const effectiveCtx: RoutingContext = {
        ...ctx,
        toolCount: ctx.toolCount ?? (hasTools ? 1 : 0)
      };
      breakdown = this.calculateScoreV2(prompt, effectiveCtx);
      score = breakdown.total;

      // ── Conversation stickiness ────────────────────────────────────
      // A follow-up like "now fix it" scores ~1.0 on its own. Blending with
      // the conversation's history stops a deep session from collapsing to
      // the Light tier mid-task.
      if (ctx.conversationId) {
        score = conversationStore.applyStickiness(
          ctx.conversationId,
          score,
          config?.stickiness ?? DEFAULT_STICKINESS_DECAY
        );
      }
    } else {
      score = this.calculateScore(prompt);
      // Legacy behaviour: tools force the Heavy tier outright.
      score = hasTools ? Math.max(score, threshold) : score;
    }

    // ── Band selection ─────────────────────────────────────────────────
    let band: Band;
    if (score < lowThreshold) band = Band.LIGHT;
    else if (score < threshold) band = Band.MEDIUM;
    else band = Band.HEAVY;

    let floorReason: string | undefined;

    if (useV2) {
      // Tool calling requires a model that reliably emits well-formed
      // tool_calls JSON. Instead of promoting every agent request to Heavy
      // (v1 behaviour, which destroyed all savings in Agent Mode), we only
      // floor the band at Medium. Escalation handles the rare case where a
      // Medium model still struggles.
      if (hasTools && BAND_ORDER[band] < BAND_ORDER[Band.MEDIUM]) {
        band = Band.MEDIUM;
        floorReason = "tool calling requires at least a Medium-tier model";
      }

      // A conversation that already escalated never drops back down.
      if (ctx.conversationId) {
        const rec = conversationStore.peek(ctx.conversationId);
        if (rec?.floorBand && BAND_ORDER[rec.floorBand] > BAND_ORDER[band]) {
          band = rec.floorBand;
          floorReason = "conversation previously escalated to this tier";
        }
      }
    }

    if (useDynamicTiers && availableModels.length > 0) {
      const selected =
        (useV2 ? ModelTiering.strongestInBandOrClosest(band, availableModels) : null) ||
        ModelTiering.selectModel(score, availableModels, lowThreshold, threshold);

      if (selected) {
        const actualBand = ModelTiering.bandOf(selected);
        return {
          model: selected,
          score,
          tier: `${actualBand} tier`,
          savings: actualBand !== Band.HEAVY,
          breakdown,
          band: actualBand,
          floorReason
        };
      }
    }

    const isStrong = band === Band.HEAVY;
    return {
      model: isStrong ? strongModel : cheapModel,
      score,
      tier: isStrong ? "Strong" : "Light",
      savings: !isStrong,
      breakdown,
      band,
      floorReason
    };
  }

  public static extractCleanPrompt(rawText?: string): string {
    if (!rawText || rawText.trim().length === 0) return "";

    const userReqMatch = rawText.match(/<user_request>([\s\S]*?)<\/user_request>/i);
    if (userReqMatch && userReqMatch[1] && userReqMatch[1].trim().length > 0) {
      return userReqMatch[1].trim();
    }

    return rawText
      .replace(/<context>[\s\S]*?<\/context>/gi, "")
      .replace(/<system>[\s\S]*?<\/system>/gi, "")
      .trim();
  }
}
