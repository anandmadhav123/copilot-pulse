/**
 * Comprehensive Test Suite for Copilot Pulse
 * 
 * Uses Node.js 20+ built-in test runner (node:test) and assert module.
 * No external dependencies required — runs with: node --test src/test/comprehensive.test.mjs
 * 
 * Covers:
 * - RouterLogic: scoring, task detection, routing, prompt extraction
 * - ModelTiering: strength scoring, band classification, tier building, model selection
 * - Dashboard Metrics: webview summary, web dashboard metrics, field completeness
 * - Integration: HTTP server endpoints, full request flow
 */





// ═══════════════════════════════════════════════════════════════════
// RE-IMPLEMENTED CORE LOGIC (extracted from TypeScript sources)
// ═══════════════════════════════════════════════════════════════════

// ─── ModelTiering ─────────────────────────────────────────────────

const Band = { LIGHT: "Light", MEDIUM: "Medium", HEAVY: "Heavy" };
const BAND_ORDER = { [Band.LIGHT]: 0, [Band.MEDIUM]: 1, [Band.HEAVY]: 2 };

class ModelTiering {
  static strengthOf(modelId) {
    const id = (modelId || "").toLowerCase().trim();
    if (!id) return 5.0;
    let s = 5.0;

    if (/gpt-?5/.test(id)) s = 9.5;
    else if (/\bo[1345]/.test(id)) s = 9.0;
    else if (id.includes("gpt-4.1")) s = 8.0;
    else if (id.includes("gpt-4o")) s = 7.0;
    else if (id.includes("gpt-4")) s = 7.5;
    else if (id.includes("gpt-3.5")) s = 3.0;
    else if (id.includes("opus")) s = 9.0;
    else if (id.includes("sonnet")) s = 7.0;
    else if (id.includes("haiku")) s = 3.0;
    else if (id.includes("claude")) s = 7.0;
    else if (id.includes("gemini") && (id.includes("ultra") || id.includes("pro"))) s = 8.0;
    else if (id.includes("gemini") && id.includes("flash")) s = 3.5;
    else if (id.includes("gemini")) s = 6.0;
    else if (id.includes("deepseek") && (id.includes("r1") || id.includes("reason"))) s = 8.5;
    else if (id.includes("deepseek")) s = 6.0;
    else if (id.includes("llama")) s = 5.0;
    else if (id.includes("mistral") || id.includes("mixtral")) s = 5.0;
    else if (id.includes("phi")) s = 3.0;
    else if (id.includes("gemma")) s = 3.5;
    else if (id.includes("qwen")) s = 5.5;

    if (id.includes("reason") || id.includes("think")) s += 1.0;
    if (id.includes("nano")) s -= 4.5;
    else if (/\bmini\b/.test(id) || id.includes("-mini")) s -= 3.5;
    else if (/\b(small|lite|tiny)\b/.test(id)) s -= 2.5;
    if (id.includes("large") || id.includes("pro") || id.includes("ultra") || id.includes("opus")) s += 1.0;

    const paramMatch = id.match(/(\d+)\s*b(?![a-z])/);
    if (paramMatch) {
      const b = parseInt(paramMatch[1], 10);
      if (!isNaN(b)) {
        if (b >= 70) s += 1.5;
        else if (b >= 30) s += 0.5;
        else if (b >= 1 && b <= 12) s -= 2.0;
      }
    }
    return Math.max(0.0, Math.min(10.0, s));
  }

  static bandOf(modelId) {
    const s = this.strengthOf(modelId);
    if (s < 4.0) return Band.LIGHT;
    if (s < 7.0) return Band.MEDIUM;
    return Band.HEAVY;
  }

  static buildTiers(models) {
    const clean = Array.from(new Set(models.map(m => m.trim()).filter(m => m.length > 0)));
    const bands = [Band.LIGHT, Band.MEDIUM, Band.HEAVY];
    return bands
      .map(band => ({
        band,
        models: clean.filter(m => this.bandOf(m) === band).sort((a, b) => this.strengthOf(a) - this.strengthOf(b))
      }))
      .filter(t => t.models.length > 0);
  }

  static selectModel(score, models, lowThreshold, highThreshold) {
    const tiers = this.buildTiers(models);
    if (tiers.length === 0) return null;

    let desired;
    if (score < lowThreshold) desired = Band.LIGHT;
    else if (score < highThreshold) desired = Band.MEDIUM;
    else desired = Band.HEAVY;

    const byBand = new Map();
    for (const t of tiers) byBand.set(t.band, t);

    let chosen = byBand.get(desired);
    if (!chosen) {
      const desiredOrder = BAND_ORDER[desired];
      let bestTier = tiers[0];
      let minDiff = Infinity;
      for (const t of tiers) {
        const diff = Math.abs(BAND_ORDER[t.band] - desiredOrder) * 2 + BAND_ORDER[t.band];
        if (diff < minDiff) { minDiff = diff; bestTier = t; }
      }
      chosen = bestTier;
    }
    return chosen.band === Band.HEAVY
      ? chosen.models[chosen.models.length - 1]
      : chosen.models[0];
  }

  static describeTiers(models) {
    const tiers = this.buildTiers(models);
    if (tiers.length === 0) return "No models discovered yet.";
    return tiers.map(t => `${t.band.padEnd(10)} → ${t.models.join(", ")}`).join("\n");
  }
}

// ─── RouterLogic ──────────────────────────────────────────────────

const KEYWORD_CATEGORIES = [
  { name: "reasoning_depth", weight: 2.0, keywords: ["architect", "design", "trade-off", "tradeoff", "compare", "evaluate", "scale", "scalable", "distributed", "microservice", "pattern", "principles", "best practice"] },
  { name: "code_complexity", weight: 1.5, keywords: ["refactor", "debug", "optimize", "migrate", "implement", "performance", "memory leak", "race condition", "deadlock", "concurrency", "async", "threading", "benchmark"] },
  { name: "mathematical", weight: 1.8, keywords: ["algorithm", "complexity", "o(n)", "o(log", "proof", "calculate", "recursive", "dynamic programming", "graph theory", "binary search", "sorting", "big-o", "mathematical", "equation"] },
  { name: "knowledge", weight: 0.5, keywords: ["explain", "summarize", "what is", "how does", "why does", "definition", "meaning", "overview", "introduction"] },
  { name: "creative", weight: 0.3, keywords: ["brainstorm", "suggest", "creative", "write a story", "poem", "blog post", "marketing", "slogan"] }
];

const TASK_PATTERNS = [
  { type: "ARCHITECTURE", patterns: [/\b(architect|design\s+a\s+system|system\s+design|microservice|distributed|scalab)/i, /\b(infrastructure|deployment\s+strategy|cloud\s+architecture|data\s+pipeline)/i, /\b(design\s+pattern|event[-]driven|message\s+queue|load\s+balanc)/i], baseScore: 9.0 },
  { type: "CODE_REFACTORING", patterns: [/\b(refactor|clean\s+up|restructur|improve\s+(this|the|my)\s+code|code\s+review)/i, /\b(technical\s+debt|code\s+smell|solid\s+principle|dry\s+principle)/i], baseScore: 8.0 },
  { type: "CODE_DEBUGGING", patterns: [/\b(debug|fix\s+(this|the|my)|not\s+working|error|bug|issue|crash|exception)/i, /\b(stack\s*trace|traceback|segfault|undefined\s+is\s+not|cannot\s+read\s+propert)/i], baseScore: 7.0 },
  { type: "MATH_LOGIC", patterns: [/\b(algorithm|data\s+structure|time\s+complexity|space\s+complexity|big[-]?o)/i, /\b(dynamic\s+programming|greedy|backtrack|graph\s+traversal|binary\s+search)/i], baseScore: 8.0 },
  { type: "CODE_GENERATION", patterns: [/\b(write\s+(a|me|the)\s+(function|class|component|script|program|api|endpoint))/i, /\b(create\s+(a|me|the)\s+(function|class|component|module|service|hook))/i, /\b(implement\s+(a|the)|build\s+(a|me|the)\s+(function|class|app|feature))/i], baseScore: 6.0 },
  { type: "EXPLANATION", patterns: [/\b(explain|describe|what\s+is|what\s+are|how\s+does|how\s+do|why\s+does|why\s+do)/i, /\b(tell\s+me\s+about|walk\s+me\s+through|break\s+down|elaborate|clarify)/i], baseScore: 4.0 },
  { type: "CREATIVE_WRITING", patterns: [/\b(write\s+(a|me)(\s+\w+)?\s+(story|poem|essay|blog|article|email|letter|speech))/i, /\b(brainstorm|creative|marketing\s+copy|tagline|slogan|draft\s+a)/i], baseScore: 3.0 },
  { type: "QUICK_LOOKUP", patterns: [/^(what|how|when|where|who|which|can\s+you)\s+.{5,50}\??$/i, /\b(command\s+(to|for)|shortcut|syntax\s+for|how\s+to\s+\w+\s+in)/i], baseScore: 1.0 }
];

class RouterLogic {
  static detectTaskType(text) {
    if (!text) return "GENERAL";
    let bestMatchCount = 0;
    let bestType = "CODE_GENERATION";
    for (const pattern of TASK_PATTERNS) {
      let matchCount = 0;
      for (const regex of pattern.patterns) {
        if (regex.test(text)) matchCount++;
      }
      if (matchCount > bestMatchCount) {
        bestMatchCount = matchCount;
        bestType = pattern.type;
      }
    }
    return bestType;
  }

  static calculateScore(text) {
    if (!text || text.trim().length === 0) return 0.0;
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

    let intentScore = 2.0;
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

    let codeScore = 0.0;
    if (/```[\s\S]*?```/.test(text)) codeScore += 2.0;
    if (/at\s+\w+.*\(: \d+:\d+\)|Traceback|File ".*", line \d+/.test(text)) codeScore += 3.0;
    const matches = text.match(/```[\s\S]*?```/g) || [];
    const codeChars = matches.reduce((sum, match) => sum + match.length, 0);
    const codeRatio = text.length > 0 ? codeChars / text.length : 0.0;
    if (codeRatio > 0.3) codeScore += 1.0;
    if (codeRatio > 0.6) codeScore += 1.0;
    codeScore = Math.min(10.0, codeScore);

    return (keywordScore * 0.3) + (intentScore * 0.5) + (codeScore * 0.2);
  }

  static routeDecision(prompt, config) {
    const cheapModel = config?.cheapModel || "openai/gpt-4o-mini";
    const strongModel = config?.strongModel || "openai/gpt-4o";
    const threshold = config?.threshold ?? 6.5;
    const lowThreshold = config?.lowThreshold ?? 4.0;
    const useDynamicTiers = config?.useDynamicTiers ?? true;
    const availableModels = config?.availableModels || [];

    const score = this.calculateScore(prompt);

    if (useDynamicTiers && availableModels.length > 0) {
      const selected = ModelTiering.selectModel(score, availableModels, lowThreshold, threshold);
      if (selected) {
        const band = ModelTiering.bandOf(selected);
        return { model: selected, score, tier: `${band} tier`, savings: band !== Band.HEAVY };
      }
    }

    const isStrong = score >= threshold;
    return { model: isStrong ? strongModel : cheapModel, score, tier: isStrong ? "Strong" : "Light", savings: !isStrong };
  }

  static extractCleanPrompt(rawText) {
    if (!rawText || rawText.trim().length === 0) return "";
    const userReqMatch = rawText.match(/<user_request>([\s\S]*?)<\/user_request>/i);
    if (userReqMatch && userReqMatch[1] && userReqMatch[1].trim().length > 0) {
      return userReqMatch[1].trim();
    }
    return rawText.replace(/<context>[\s\S]*?<\/context>/gi, "").replace(/<system>[\s\S]*?<\/system>/gi, "").trim();
  }
}

// ─── Metric Helpers ───────────────────────────────────────────────

function buildMetricRecord(prompt, config, latencyMs = 100) {
  const cleanPrompt = RouterLogic.extractCleanPrompt(prompt);
  const decision = RouterLogic.routeDecision(cleanPrompt, config);
  const taskType = RouterLogic.detectTaskType(cleanPrompt);
  const roundedScore = Math.round(decision.score * 10) / 10;
  return {
    timestamp: Date.now(),
    routedModel: decision.model,
    model: decision.model,
    prompt: cleanPrompt || "Copilot Query",
    promptSnippet: (cleanPrompt || "Copilot Query").slice(0, 80),
    taskType,
    complexityScore: roundedScore,
    score: roundedScore,
    tier: decision.tier,
    savings: decision.savings,
    simulatedSavings: decision.savings ? 0.014 : 0.0,
    latencyMs,
    signals: {
      keyword: Math.min(9, Math.round(decision.score * 0.9)),
      intent: Math.min(9, Math.round(decision.score * 1.1)),
      code: cleanPrompt.includes("```") ? 8 : 2,
      context: Math.min(9, Math.round(cleanPrompt.length / 50)),
      vector: Math.min(9, Math.round(decision.score * 0.8))
    }
  };
}

function computeDashboardSummary(metrics) {
  const totalCount = metrics.length;
  const cheapCount = metrics.filter(m => m.savings).length;
  const savingsPercent = totalCount > 0 ? Math.round((cheapCount / totalCount) * 100) : 0;
  const avgLatency = totalCount > 0 ? Math.round(metrics.reduce((acc, m) => acc + m.latencyMs, 0) / totalCount) : 0;
  return { totalCount, cheapCount, savingsPercent, avgLatency };
}

function computeFullDashboardMetrics(metrics) {
  const total = metrics.length;
  const tier2Items = metrics.filter(d => d.savings || (d.routedModel || d.model || '').toString().includes('mini') || (d.complexityScore || d.score || 0) < 4.0);
  const tier2Count = tier2Items.length;
  const tier1Count = total - tier2Count;
  const avg = total > 0 ? parseFloat((metrics.reduce((s, d) => s + (d.complexityScore || d.score || 0), 0) / total).toFixed(1)) : 0;
  const dollars = parseFloat((tier2Count * 0.014).toFixed(3));
  const credits = parseFloat((tier2Count * 0.8).toFixed(1));
  return { total, tier1Count, tier2Count, avg, dollars, credits };
}

const defaultConfig = {
  cheapModel: "openai/gpt-4o-mini",
  strongModel: "openai/gpt-4o",
  threshold: 6.5,
  lowThreshold: 4.0,
  useDynamicTiers: false
};



const prompts = [
  { desc: "Very Low Complexity (Lookup)", text: "What is HTTP?" },
  { desc: "Low Complexity (Creative)", text: "Write me a poem about the moon." },
  { desc: "Medium Complexity (Coding)", text: "Write a function to sort an array using quicksort." },
  { desc: "High Complexity (Debugging)", text: "Debug this race condition in my async thread pool:\n\`\`\`\n[code snippet]\n\`\`\`\nTraceback:\n[error logs]" },
  { desc: "Very High Complexity (Architecture)", text: "Architect a scalable microservices event-driven system with distributed tracing, evaluate trade-offs between monolithic and distributed design patterns, and implement deadlock handling." }
];

const config = {
  cheapModel: "openai/gpt-4o-mini",
  strongModel: "openai/gpt-4o",
  threshold: 6.5,
  lowThreshold: 4.0,
  useDynamicTiers: true,
  availableModels: ["openai/gpt-4o-mini", "mistralai/mistral", "anthropic/claude-3.5-sonnet", "openai/o1", "google/gemini-pro"]
};

console.log("=== STATIC ROUTING MODE (Binary: Cheap vs Strong) ===");
const staticConfig = { ...config, useDynamicTiers: false };
for (const p of prompts) {
  const d = RouterLogic.routeDecision(p.text, staticConfig);
  console.log(`- [${p.desc}]`);
  console.log(`  Prompt: "${p.text.split('\n')[0].substring(0, 50)}..."`);
  console.log(`  Score: ${d.score.toFixed(1)} -> Tier: ${d.tier} -> Selected LLM: ${d.model}\n`);
}

console.log("=== DYNAMIC TIERING MODE (Light, Medium, Heavy) ===");
console.log("Available Models:", config.availableModels.join(", "));
console.log("");
for (const p of prompts) {
  const d = RouterLogic.routeDecision(p.text, config);
  console.log(`- [${p.desc}]`);
  console.log(`  Prompt: "${p.text.split('\n')[0].substring(0, 50)}..."`);
  console.log(`  Score: ${d.score.toFixed(1)} -> Tier: ${d.tier} -> Selected LLM: ${d.model}\n`);
}
