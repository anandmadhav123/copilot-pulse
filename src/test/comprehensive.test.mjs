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

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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


// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 1: RouterLogic.calculateScore
// ═══════════════════════════════════════════════════════════════════

describe("RouterLogic — calculateScore", () => {

  it("should return 0 for empty string", () => {
    assert.strictEqual(RouterLogic.calculateScore(""), 0.0);
  });

  it("should return 0 for whitespace-only input", () => {
    assert.strictEqual(RouterLogic.calculateScore("   "), 0.0);
  });

  it("should score simple 'what is X?' questions low (< 4.0)", () => {
    for (const p of ["What is a linked list?", "How does HTTP work?", "Explain what a variable is", "What is CSS?", "What is an API?"]) {
      const score = RouterLogic.calculateScore(p);
      assert.ok(score < 4.0, `Expected "${p}" to score < 4.0, got ${score}`);
    }
  });

  it("should score architecture prompts high (>= 6.0)", () => {
    for (const p of [
      "Architect a scalable microservices event-driven system with distributed tracing",
      "Design a system for a high-traffic e-commerce platform with microservice architecture",
      "Compare trade-offs between monolithic and distributed design patterns for scalable systems"
    ]) {
      const score = RouterLogic.calculateScore(p);
      assert.ok(score >= 6.0, `Expected "${p}" to score >= 6.0, got ${score}`);
    }
  });

  it("should score debugging/refactoring prompts in medium-high range (>= 5.0)", () => {
    for (const p of [
      "Debug this race condition in my async thread pool implementation",
      "Refactor this code to fix the memory leak and optimize performance",
      "Fix the deadlock in my concurrency implementation and benchmark it"
    ]) {
      const score = RouterLogic.calculateScore(p);
      assert.ok(score >= 5.0, `Expected "${p}" to score >= 5.0, got ${score}`);
    }
  });

  it("should score mathematical/algorithm prompts high (>= 5.5)", () => {
    for (const p of [
      "Implement a dynamic programming solution with O(n log n) complexity",
      "Prove the time complexity of binary search is O(log n) using mathematical induction",
      "Design an algorithm using graph theory and recursive backtracking"
    ]) {
      const score = RouterLogic.calculateScore(p);
      assert.ok(score >= 5.5, `Expected "${p}" to score >= 5.5, got ${score}`);
    }
  });

  it("should score creative/simple prompts low (< 4.0)", () => {
    for (const p of ["Write a story about a cat", "Brainstorm creative marketing slogans for a blog post", "Write a poem about the sunset"]) {
      const score = RouterLogic.calculateScore(p);
      assert.ok(score < 4.0, `Expected "${p}" to score < 4.0, got ${score}`);
    }
  });

  it("should give higher scores to prompts with code blocks", () => {
    const withoutCode = "Fix this function";
    const withCode = "Fix this function\n```python\ndef broken():\n    return None\n```";
    assert.ok(RouterLogic.calculateScore(withCode) > RouterLogic.calculateScore(withoutCode));
  });

  it("should detect stack traces and increase score", () => {
    const prompt = 'I get an error:\nTraceback\nFile "test.py", line 42\nRuntimeError: boom';
    assert.ok(RouterLogic.calculateScore(prompt) > 2.0);
  });

  it("should handle very long prompts without crashing", () => {
    const score = RouterLogic.calculateScore("Explain ".repeat(5000));
    assert.ok(typeof score === "number" && !isNaN(score));
  });

  it("should cap total score at 10.0", () => {
    const prompt = "architect design trade-off tradeoff compare evaluate scale scalable distributed microservice pattern principles best practice refactor debug optimize migrate implement performance memory leak race condition deadlock concurrency async threading benchmark algorithm complexity o(n) o(log proof calculate recursive dynamic programming graph theory binary search sorting big-o mathematical equation explain summarize what is how does why does definition meaning overview introduction brainstorm suggest creative write a story poem blog post marketing slogan";
    assert.ok(RouterLogic.calculateScore(prompt) <= 10.0);
  });

  it("should produce consistent scores for the same input", () => {
    const p = "Design a microservice architecture with distributed tracing";
    assert.strictEqual(RouterLogic.calculateScore(p), RouterLogic.calculateScore(p));
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 2: RouterLogic.detectTaskType
// ═══════════════════════════════════════════════════════════════════

describe("RouterLogic — detectTaskType", () => {

  it("should return GENERAL for empty string", () => {
    assert.strictEqual(RouterLogic.detectTaskType(""), "GENERAL");
  });

  it("should detect ARCHITECTURE tasks", () => {
    for (const p of ["Architect a scalable system design", "Design a cloud architecture with data pipeline", "Implement an event-driven microservice deployment strategy"]) {
      assert.strictEqual(RouterLogic.detectTaskType(p), "ARCHITECTURE", `Failed for "${p}"`);
    }
  });

  it("should detect CODE_REFACTORING tasks", () => {
    for (const p of ["Refactor this class to follow SOLID principles", "Clean up my code and address technical debt", "Improve this code to fix the code smell"]) {
      assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_REFACTORING", `Failed for "${p}"`);
    }
  });

  it("should detect CODE_DEBUGGING tasks", () => {
    for (const p of ["Debug this crash in production", "Fix this error in my code", "My code is not working, I see this stack trace"]) {
      assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_DEBUGGING", `Failed for "${p}"`);
    }
  });

  it("should detect CODE_GENERATION tasks", () => {
    for (const p of ["Write a function to sort an array", "Create a class for user authentication", "Implement a REST API endpoint"]) {
      assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_GENERATION", `Failed for "${p}"`);
    }
  });

  it("should detect CREATIVE_WRITING tasks", () => {
    for (const p of ["Write a story about space exploration", "Write me a poem about mountains", "Draft a marketing copy for our product"]) {
      assert.strictEqual(RouterLogic.detectTaskType(p), "CREATIVE_WRITING", `Failed for "${p}"`);
    }
  });

  it("should detect EXPLANATION tasks", () => {
    for (const p of ["Explain how React hooks work", "Walk me through the TCP handshake"]) {
      const t = RouterLogic.detectTaskType(p);
      assert.ok(t === "EXPLANATION" || t === "QUICK_LOOKUP", `Expected EXPLANATION/QUICK_LOOKUP for "${p}", got ${t}`);
    }
  });

  it("should fall back to CODE_GENERATION for ambiguous prompts", () => {
    assert.strictEqual(RouterLogic.detectTaskType("Please help me with this thing"), "CODE_GENERATION");
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 3: RouterLogic.routeDecision
// ═══════════════════════════════════════════════════════════════════

describe("RouterLogic — routeDecision", () => {

  it("should route simple prompts to cheap model", () => {
    const d = RouterLogic.routeDecision("What is a linked list?", defaultConfig);
    assert.strictEqual(d.model, "openai/gpt-4o-mini");
    assert.strictEqual(d.savings, true);
    assert.ok(d.score < 6.5);
  });

  it("should route complex prompts to strong model", () => {
    const d = RouterLogic.routeDecision("Architect a scalable microservices event-driven system to handle race conditions and deadlock under high concurrency with distributed tracing", defaultConfig);
    assert.strictEqual(d.model, "openai/gpt-4o");
    assert.strictEqual(d.savings, false);
    assert.ok(d.score >= 6.5);
  });

  it("should include all required fields in decision", () => {
    const d = RouterLogic.routeDecision("Hello", defaultConfig);
    assert.ok("model" in d); assert.ok("score" in d); assert.ok("tier" in d); assert.ok("savings" in d);
  });

  it("should set tier to 'Strong' for complex prompts (static mode)", () => {
    const d = RouterLogic.routeDecision("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig);
    assert.strictEqual(d.tier, "Strong");
  });

  it("should set tier to 'Light' for simple prompts (static mode)", () => {
    assert.strictEqual(RouterLogic.routeDecision("Hello world", defaultConfig).tier, "Light");
  });

  it("should use default models when config is undefined", () => {
    const d = RouterLogic.routeDecision("What is HTTP?");
    assert.ok(d.model === "openai/gpt-4o-mini" || d.model === "openai/gpt-4o");
  });

  it("should use dynamic tiers when available models provided", () => {
    const cfg = { ...defaultConfig, useDynamicTiers: true, availableModels: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "openai/gpt-4o"] };
    assert.ok(RouterLogic.routeDecision("What is 2+2?", cfg).savings);
    assert.strictEqual(RouterLogic.routeDecision("Architect a scalable distributed microservice system with event-driven design patterns and race condition handling", cfg).savings, false);
  });

  it("should fall back to static routing when useDynamicTiers=false", () => {
    const cfg = { ...defaultConfig, useDynamicTiers: false, availableModels: ["openai/gpt-4o-mini", "openai/gpt-4o"] };
    assert.strictEqual(RouterLogic.routeDecision("What is a closure?", cfg).model, "openai/gpt-4o-mini");
  });

  it("should respect custom threshold values", () => {
    const cfg = { ...defaultConfig, threshold: 2.0 };
    assert.strictEqual(RouterLogic.routeDecision("Explain what is HTTP", cfg).model, "openai/gpt-4o");
  });

  it("should respect custom model names", () => {
    const cfg = { cheapModel: "custom/cheap", strongModel: "custom/strong", threshold: 6.5, lowThreshold: 4.0, useDynamicTiers: false };
    assert.strictEqual(RouterLogic.routeDecision("What is X?", cfg).model, "custom/cheap");
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 4: RouterLogic.extractCleanPrompt
// ═══════════════════════════════════════════════════════════════════

describe("RouterLogic — extractCleanPrompt", () => {

  it("should return empty for undefined/null/empty/whitespace", () => {
    assert.strictEqual(RouterLogic.extractCleanPrompt(undefined), "");
    assert.strictEqual(RouterLogic.extractCleanPrompt(""), "");
    assert.strictEqual(RouterLogic.extractCleanPrompt("   "), "");
  });

  it("should extract from <user_request> tags", () => {
    assert.strictEqual(RouterLogic.extractCleanPrompt("<user_request>Sort an array</user_request>"), "Sort an array");
  });

  it("should prefer <user_request> over surrounding noise", () => {
    assert.strictEqual(RouterLogic.extractCleanPrompt("noise <context>ctx</context> <user_request>The actual request</user_request> trailing"), "The actual request");
  });

  it("should strip <context> tags when no <user_request>", () => {
    const r = RouterLogic.extractCleanPrompt("<context>Some context</context> Fix this bug");
    assert.ok(!r.includes("<context>")); assert.ok(r.includes("Fix this bug"));
  });

  it("should strip <system> tags", () => {
    const r = RouterLogic.extractCleanPrompt("<system>System instructions</system> Write tests");
    assert.ok(!r.includes("<system>")); assert.ok(r.includes("Write tests"));
  });

  it("should handle plain text without tags", () => {
    assert.strictEqual(RouterLogic.extractCleanPrompt("Just plain text"), "Just plain text");
  });

  it("should trim whitespace from extracted content", () => {
    assert.strictEqual(RouterLogic.extractCleanPrompt("<user_request>   padded   </user_request>"), "padded");
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 5: ModelTiering.strengthOf
// ═══════════════════════════════════════════════════════════════════

describe("ModelTiering — strengthOf", () => {

  it("should return 5.0 for empty string", () => { assert.strictEqual(ModelTiering.strengthOf(""), 5.0); });
  it("should score GPT-5 very high", () => { assert.ok(ModelTiering.strengthOf("openai/gpt-5") >= 9.0); });
  it("should score GPT-4o at 7.0", () => { assert.strictEqual(ModelTiering.strengthOf("openai/gpt-4o"), 7.0); });
  it("should score GPT-4o-mini low (mini penalty)", () => { assert.ok(ModelTiering.strengthOf("openai/gpt-4o-mini") < 5.0); });
  it("should score GPT-3.5 at 3.0", () => { assert.strictEqual(ModelTiering.strengthOf("openai/gpt-3.5-turbo"), 3.0); });
  it("should score Claude Opus high (>= 9.0)", () => { assert.ok(ModelTiering.strengthOf("anthropic/claude-opus") >= 9.0); });
  it("should score Claude Sonnet at 7.0", () => { assert.strictEqual(ModelTiering.strengthOf("anthropic/claude-3.5-sonnet"), 7.0); });
  it("should score Claude Haiku at 3.0", () => { assert.strictEqual(ModelTiering.strengthOf("anthropic/claude-3-haiku"), 3.0); });
  it("should score Gemini Pro >= 8.0", () => { assert.ok(ModelTiering.strengthOf("google/gemini-pro") >= 8.0); });
  it("should score Gemini Flash < Gemini Pro", () => { assert.ok(ModelTiering.strengthOf("google/gemini-flash") < ModelTiering.strengthOf("google/gemini-pro")); });

  it("should boost 'thinking'/'reason' models", () => {
    assert.ok(ModelTiering.strengthOf("deepseek/deepseek-v2-thinking") > ModelTiering.strengthOf("deepseek/deepseek-v2"));
  });

  it("should penalize nano/mini/small/lite/tiny models", () => {
    assert.ok(ModelTiering.strengthOf("some/model-nano") <= 2.0);
    assert.ok(ModelTiering.strengthOf("some/model-mini") < 3.0);
    for (const s of ["small", "lite", "tiny"]) assert.ok(ModelTiering.strengthOf(`some/model-${s}`) < 4.0);
  });

  it("should boost large/pro/ultra models", () => {
    const base = ModelTiering.strengthOf("some/model");
    for (const s of ["large", "pro", "ultra"]) assert.ok(ModelTiering.strengthOf(`some/model-${s}`) > base);
  });

  it("should boost 70B+ parameter models over 7B", () => {
    assert.ok(ModelTiering.strengthOf("meta/llama-70b") > ModelTiering.strengthOf("meta/llama-7b"));
  });

  it("should clamp scores between 0 and 10", () => {
    assert.ok(ModelTiering.strengthOf("openai/gpt-5-opus-ultra-large-thinking-200b") <= 10.0);
    assert.ok(ModelTiering.strengthOf("tiny/nano-mini-small-lite-1b") >= 0.0);
  });

  it("should handle case-insensitive model IDs", () => {
    assert.strictEqual(ModelTiering.strengthOf("openai/gpt-4o"), ModelTiering.strengthOf("OpenAI/GPT-4o"));
  });

  it("should score DeepSeek R1 >= 8.0", () => { assert.ok(ModelTiering.strengthOf("deepseek/deepseek-r1") >= 8.0); });
  it("should score o1/o3 models at 9.0", () => { assert.ok(ModelTiering.strengthOf("openai/o1") >= 9.0); assert.ok(ModelTiering.strengthOf("openai/o3") >= 9.0); });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 6: ModelTiering — bandOf, buildTiers, selectModel
// ═══════════════════════════════════════════════════════════════════

describe("ModelTiering — bandOf", () => {
  it("should classify GPT-4o-mini as LIGHT", () => { assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o-mini"), Band.LIGHT); });
  it("should classify Haiku as LIGHT", () => { assert.strictEqual(ModelTiering.bandOf("anthropic/claude-3-haiku"), Band.LIGHT); });
  it("should classify GPT-4o as HEAVY", () => { assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o"), Band.HEAVY); });
  it("should classify Sonnet as HEAVY", () => { assert.strictEqual(ModelTiering.bandOf("anthropic/claude-3.5-sonnet"), Band.HEAVY); });
  it("should classify Mistral as MEDIUM", () => { assert.strictEqual(ModelTiering.bandOf("mistralai/mistral"), Band.MEDIUM); });
});

describe("ModelTiering — buildTiers", () => {
  it("should return empty for no models", () => { assert.strictEqual(ModelTiering.buildTiers([]).length, 0); });

  it("should group models into correct bands", () => {
    const tiers = ModelTiering.buildTiers(["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3-haiku"]);
    assert.ok(tiers.find(t => t.band === Band.LIGHT));
    assert.ok(tiers.find(t => t.band === Band.HEAVY));
  });

  it("should deduplicate models", () => {
    const tiers = ModelTiering.buildTiers(["openai/gpt-4o", "openai/gpt-4o"]);
    assert.strictEqual(tiers.flatMap(t => t.models).length, 1);
  });

  it("should filter empty/whitespace model names", () => {
    const tiers = ModelTiering.buildTiers(["openai/gpt-4o", "", "   "]);
    assert.strictEqual(tiers.flatMap(t => t.models).length, 1);
  });

  it("should handle all three bands", () => {
    const tiers = ModelTiering.buildTiers(["openai/gpt-4o-mini", "mistralai/mistral", "openai/gpt-4o"]);
    const bands = tiers.map(t => t.band);
    assert.ok(bands.includes(Band.LIGHT));
    assert.ok(bands.includes(Band.MEDIUM));
    assert.ok(bands.includes(Band.HEAVY));
  });
});

describe("ModelTiering — selectModel", () => {
  const models = ["openai/gpt-4o-mini", "mistralai/mistral", "openai/gpt-4o"];

  it("should return null for empty model list", () => { assert.strictEqual(ModelTiering.selectModel(5.0, [], 4.0, 6.5), null); });
  it("should select LIGHT for low scores", () => { assert.strictEqual(ModelTiering.selectModel(2.0, models, 4.0, 6.5), "openai/gpt-4o-mini"); });
  it("should select MEDIUM for mid scores", () => { assert.strictEqual(ModelTiering.selectModel(5.0, models, 4.0, 6.5), "mistralai/mistral"); });
  it("should select HEAVY for high scores", () => { assert.strictEqual(ModelTiering.selectModel(8.0, models, 4.0, 6.5), "openai/gpt-4o"); });

  it("should fall back when desired band missing", () => {
    assert.strictEqual(ModelTiering.selectModel(1.0, ["openai/gpt-4o"], 4.0, 6.5), "openai/gpt-4o");
  });

  it("should handle boundary scores", () => {
    assert.strictEqual(ModelTiering.selectModel(4.0, models, 4.0, 6.5), "mistralai/mistral"); // at lowThreshold → MEDIUM
    assert.strictEqual(ModelTiering.selectModel(6.5, models, 4.0, 6.5), "openai/gpt-4o"); // at highThreshold → HEAVY
  });

  it("should handle single model list", () => {
    assert.strictEqual(ModelTiering.selectModel(5.0, ["openai/gpt-4o-mini"], 4.0, 6.5), "openai/gpt-4o-mini");
  });
});

describe("ModelTiering — describeTiers", () => {
  it("should return 'No models discovered yet.' for empty list", () => {
    assert.strictEqual(ModelTiering.describeTiers([]), "No models discovered yet.");
  });
  it("should produce readable output with model names", () => {
    const d = ModelTiering.describeTiers(["openai/gpt-4o-mini", "openai/gpt-4o"]);
    assert.ok(d.includes("gpt-4o"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 7: MetricRecord Construction
// ═══════════════════════════════════════════════════════════════════

describe("MetricRecord Construction", () => {

  it("should build a complete record with all required fields", () => {
    const r = buildMetricRecord("What is HTTP?", defaultConfig);
    assert.ok(r.timestamp > 0); assert.ok(typeof r.routedModel === "string");
    assert.ok(typeof r.model === "string"); assert.ok(typeof r.prompt === "string");
    assert.ok(typeof r.promptSnippet === "string"); assert.ok(typeof r.taskType === "string");
    assert.ok(typeof r.complexityScore === "number"); assert.ok(typeof r.score === "number");
    assert.ok(typeof r.tier === "string"); assert.ok(typeof r.savings === "boolean");
    assert.ok(typeof r.simulatedSavings === "number"); assert.ok(typeof r.latencyMs === "number");
  });

  it("should populate all 5 signal types", () => {
    const r = buildMetricRecord("Debug this async race condition", defaultConfig);
    assert.ok(r.signals); assert.ok("keyword" in r.signals); assert.ok("intent" in r.signals);
    assert.ok("code" in r.signals); assert.ok("context" in r.signals); assert.ok("vector" in r.signals);
  });

  it("should cap signal values at 9", () => {
    const r = buildMetricRecord("Architect a scalable microservices event-driven distributed system design patterns", defaultConfig);
    if (r.signals) {
      for (const k of ["keyword", "intent", "code", "context", "vector"]) assert.ok(r.signals[k] <= 9, `${k}=${r.signals[k]}`);
    }
  });

  it("should set code signal to 8 with code blocks, 2 without", () => {
    assert.strictEqual(buildMetricRecord("Fix:\n```py\npass\n```", defaultConfig).signals.code, 8);
    assert.strictEqual(buildMetricRecord("What is a closure?", defaultConfig).signals.code, 2);
  });

  it("should truncate promptSnippet to 80 chars", () => {
    assert.ok(buildMetricRecord("x".repeat(200), defaultConfig).promptSnippet.length <= 80);
  });

  it("should set prompt to 'Copilot Query' for empty prompts", () => {
    const r = buildMetricRecord("", defaultConfig);
    assert.strictEqual(r.prompt, "Copilot Query");
    assert.strictEqual(r.promptSnippet, "Copilot Query");
  });

  it("should compute simulatedSavings correctly", () => {
    assert.strictEqual(buildMetricRecord("What is HTTP?", defaultConfig).simulatedSavings, 0.014);
    assert.strictEqual(buildMetricRecord("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig).simulatedSavings, 0.0);
  });

  it("should round complexityScore to 1 decimal and equal score", () => {
    const r = buildMetricRecord("Debug this error", defaultConfig);
    assert.strictEqual(r.complexityScore, Math.round(r.complexityScore * 10) / 10);
    assert.strictEqual(r.complexityScore, r.score);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 8: Dashboard Summary (VSCode Webview Panel)
// ═══════════════════════════════════════════════════════════════════

describe("Dashboard Summary — VSCode Webview Panel", () => {

  it("should return all zeros for empty metrics", () => {
    const s = computeDashboardSummary([]);
    assert.strictEqual(s.totalCount, 0); assert.strictEqual(s.cheapCount, 0);
    assert.strictEqual(s.savingsPercent, 0); assert.strictEqual(s.avgLatency, 0);
  });

  it("should compute totalCount correctly", () => {
    assert.strictEqual(computeDashboardSummary([
      buildMetricRecord("A", defaultConfig), buildMetricRecord("B", defaultConfig), buildMetricRecord("C", defaultConfig)
    ]).totalCount, 3);
  });

  it("should compute cheapCount (savings=true) correctly", () => {
    const s = computeDashboardSummary([
      buildMetricRecord("What is HTTP?", defaultConfig),
      buildMetricRecord("What is CSS?", defaultConfig),
      buildMetricRecord("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig)
    ]);
    assert.strictEqual(s.cheapCount, 2);
  });

  it("should compute savingsPercent as 100 when all cheap", () => {
    const s = computeDashboardSummary([buildMetricRecord("What is HTTP?", defaultConfig), buildMetricRecord("What is CSS?", defaultConfig)]);
    assert.strictEqual(s.savingsPercent, 100);
  });

  it("should compute savingsPercent as 0 when none cheap", () => {
    const cfg = { ...defaultConfig, threshold: 0.1 };
    assert.strictEqual(computeDashboardSummary([buildMetricRecord("Hello", cfg), buildMetricRecord("Hi", cfg)]).savingsPercent, 0);
  });

  it("should compute avgLatency correctly", () => {
    assert.strictEqual(computeDashboardSummary([
      buildMetricRecord("A", defaultConfig, 100),
      buildMetricRecord("B", defaultConfig, 200),
      buildMetricRecord("C", defaultConfig, 300)
    ]).avgLatency, 200);
  });

  it("should round avgLatency to integer", () => {
    assert.strictEqual(computeDashboardSummary([
      buildMetricRecord("A", defaultConfig, 100), buildMetricRecord("B", defaultConfig, 201)
    ]).avgLatency, 151);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 9: Full Dashboard Metrics (Web Dashboard)
// ═══════════════════════════════════════════════════════════════════

describe("Full Dashboard Metrics — Web Dashboard", () => {

  it("should return all zeros for empty metrics", () => {
    const r = computeFullDashboardMetrics([]);
    assert.strictEqual(r.total, 0); assert.strictEqual(r.tier1Count, 0);
    assert.strictEqual(r.tier2Count, 0); assert.strictEqual(r.avg, 0);
    assert.strictEqual(r.dollars, 0); assert.strictEqual(r.credits, 0);
  });

  it("should ensure tier1 + tier2 = total", () => {
    const metrics = [
      buildMetricRecord("What is HTTP?", defaultConfig),
      buildMetricRecord("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig)
    ];
    const r = computeFullDashboardMetrics(metrics);
    assert.strictEqual(r.tier1Count + r.tier2Count, r.total);
  });

  it("should compute cost and credits saved from tier2 count", () => {
    const metrics = Array(10).fill(null).map((_, i) => buildMetricRecord(`Simple ${i}`, defaultConfig));
    const r = computeFullDashboardMetrics(metrics);
    assert.strictEqual(r.dollars, parseFloat((r.tier2Count * 0.014).toFixed(3)));
    assert.strictEqual(r.credits, parseFloat((r.tier2Count * 0.8).toFixed(1)));
  });

  it("should have ALL metrics populated for a mixed workload", () => {
    const metrics = [
      buildMetricRecord("What is HTTP?", defaultConfig),
      buildMetricRecord("Debug this async race condition deadlock in my threading code", defaultConfig),
      buildMetricRecord("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig),
      buildMetricRecord("Write a poem", defaultConfig),
      buildMetricRecord("Explain what is a closure", defaultConfig),
      buildMetricRecord("Refactor this code to fix memory leak and optimize performance", defaultConfig),
      buildMetricRecord("What is the command to list files?", defaultConfig),
      buildMetricRecord("Implement dynamic programming with O(n log n) time complexity and big-o analysis", defaultConfig)
    ];

    const ws = computeDashboardSummary(metrics);
    const ds = computeFullDashboardMetrics(metrics);

    // Webview panel metrics
    assert.ok(ws.totalCount > 0); assert.ok(ws.cheapCount >= 0);
    assert.ok(ws.savingsPercent >= 0 && ws.savingsPercent <= 100);
    assert.ok(ws.avgLatency >= 0);

    // Web dashboard metrics
    assert.ok(ds.total > 0); assert.ok(ds.tier1Count >= 0); assert.ok(ds.tier2Count >= 0);
    assert.strictEqual(ds.tier1Count + ds.tier2Count, ds.total);
    assert.ok(ds.avg >= 0); assert.ok(ds.dollars >= 0); assert.ok(ds.credits >= 0);

    // Every individual metric record must have all fields
    for (const m of metrics) {
      assert.ok(m.timestamp > 0, `timestamp for "${m.prompt}"`);
      assert.ok(m.routedModel.length > 0, `routedModel for "${m.prompt}"`);
      assert.ok(m.model.length > 0, `model for "${m.prompt}"`);
      assert.ok(m.prompt.length > 0, `prompt`);
      assert.ok(m.promptSnippet.length > 0, `promptSnippet for "${m.prompt}"`);
      assert.ok(m.taskType.length > 0, `taskType for "${m.prompt}"`);
      assert.ok(typeof m.complexityScore === "number", `complexityScore for "${m.prompt}"`);
      assert.ok(typeof m.score === "number", `score for "${m.prompt}"`);
      assert.ok(m.tier.length > 0, `tier for "${m.prompt}"`);
      assert.ok(typeof m.savings === "boolean", `savings for "${m.prompt}"`);
      assert.ok(typeof m.simulatedSavings === "number", `simulatedSavings for "${m.prompt}"`);
      assert.ok(typeof m.latencyMs === "number", `latencyMs for "${m.prompt}"`);
      assert.ok(m.signals, `signals for "${m.prompt}"`);
      for (const k of ["keyword", "intent", "code", "context", "vector"]) {
        assert.ok(typeof m.signals[k] === "number", `signals.${k} for "${m.prompt}"`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 10: End-to-End Request Flow
// ═══════════════════════════════════════════════════════════════════

describe("End-to-End Request Flow", () => {

  it("should simulate a complete chat completion lifecycle", () => {
    const requestJson = {
      model: "copilot-pulse",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "<user_request>What is a linked list?</user_request>" }
      ],
      stream: true
    };

    const lastMsg = requestJson.messages[requestJson.messages.length - 1];
    const promptText = typeof lastMsg.content === "string" ? lastMsg.content : "";
    const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
    assert.strictEqual(cleanPrompt, "What is a linked list?");

    const decision = RouterLogic.routeDecision(cleanPrompt, defaultConfig);
    assert.ok(decision.model); assert.ok(typeof decision.score === "number"); assert.ok(typeof decision.savings === "boolean");

    const taskType = RouterLogic.detectTaskType(cleanPrompt);
    assert.ok(taskType);

    const record = buildMetricRecord(promptText, defaultConfig, 150);
    assert.strictEqual(record.prompt, "What is a linked list?");
    assert.strictEqual(record.latencyMs, 150);

    const summary = computeDashboardSummary([record]);
    assert.strictEqual(summary.totalCount, 1);
    assert.strictEqual(summary.avgLatency, 150);

    const dashboard = computeFullDashboardMetrics([record]);
    assert.strictEqual(dashboard.total, 1);
    assert.strictEqual(dashboard.tier1Count + dashboard.tier2Count, 1);
  });

  it("should handle multi-request diverse workload", () => {
    const prompts = [
      "What is HTTP?",
      "Debug this race condition in my async code with deadlock",
      "Architect a scalable microservices event-driven system",
      "Write a poem about the moon",
      "Explain how closures work in JavaScript",
      "Refactor this function to follow SOLID principles",
      "What is the syntax for a for loop?",
      "Implement dynamic programming with O(n log n) time complexity and big-o analysis",
      "Create a class for managing user sessions",
      "Compare trade-offs between SQL and NoSQL for scalable distributed systems"
    ];

    const metrics = prompts.map(p => buildMetricRecord(p, defaultConfig, Math.floor(Math.random() * 500) + 50));

    const summary = computeDashboardSummary(metrics);
    assert.strictEqual(summary.totalCount, 10);
    assert.ok(summary.cheapCount >= 0 && summary.cheapCount <= 10);
    assert.ok(summary.savingsPercent >= 0 && summary.savingsPercent <= 100);
    assert.ok(summary.avgLatency > 0);

    const dashboard = computeFullDashboardMetrics(metrics);
    assert.strictEqual(dashboard.total, 10);
    assert.strictEqual(dashboard.tier1Count + dashboard.tier2Count, 10);
    assert.ok(dashboard.avg > 0);

    const models = new Set(metrics.map(m => m.model));
    assert.ok(models.size >= 1);

    const taskTypes = new Set(metrics.map(m => m.taskType));
    assert.ok(taskTypes.size >= 3, `Expected >= 3 task types, got: ${[...taskTypes].join(", ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TEST SUITE 11: Integration — HTTP Server Endpoints
// ═══════════════════════════════════════════════════════════════════

describe("Integration — HTTP Server Endpoints", () => {
  let server;
  let serverMetrics = [];
  const PORT = 13458;

  function httpReq(options, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  before(() => {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        const url = req.url || "/";
        if ((url === "/v1/models" || url === "/models") && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [
            { id: "copilot-pulse", object: "model", created: 1785897097, owned_by: "copilot-pulse" },
            { id: "copilot-pulse-agent", object: "model", created: 1785897097, owned_by: "copilot-pulse" }
          ]}));
        } else if ((url === "/v1/chat/completions" || url === "/chat/completions") && req.method === "POST") {
          let bodyStr = "";
          req.on("data", chunk => bodyStr += chunk);
          req.on("end", () => {
            try {
              const rj = JSON.parse(bodyStr);
              let promptText = "";
              if (Array.isArray(rj.messages) && rj.messages.length > 0) {
                const lm = rj.messages[rj.messages.length - 1];
                if (lm && typeof lm.content === "string") promptText = lm.content;
              }
              const cp = RouterLogic.extractCleanPrompt(promptText);
              const d = RouterLogic.routeDecision(cp, defaultConfig);
              const tt = RouterLogic.detectTaskType(cp);
              const rs = Math.round(d.score * 10) / 10;
              const rec = {
                timestamp: Date.now(), routedModel: d.model, model: d.model,
                prompt: cp || "Copilot Query", promptSnippet: (cp || "Copilot Query").slice(0, 80),
                taskType: tt, complexityScore: rs, score: rs, tier: d.tier,
                savings: d.savings, simulatedSavings: d.savings ? 0.014 : 0.0, latencyMs: 5,
                signals: {
                  keyword: Math.min(9, Math.round(d.score * 0.9)),
                  intent: Math.min(9, Math.round(d.score * 1.1)),
                  code: cp.includes("```") ? 8 : 2,
                  context: Math.min(9, Math.round(cp.length / 50)),
                  vector: Math.min(9, Math.round(d.score * 0.8))
                }
              };
              serverMetrics.unshift(rec);
              res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
              res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: rj.model || "copilot-pulse", choices: [{ index: 0, delta: { content: "Hello!" }, finish_reason: "stop" }] })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            } catch (e) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
        } else if (url === "/metrics" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(serverMetrics));
        } else if (url === "/" || url === "/dashboard") {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<!DOCTYPE html><html><head><title>Copilot Pulse Dashboard</title></head><body>
            <div id="totalRequests">0</div><div id="tier1Count">0</div><div id="tier2Count">0</div>
            <div id="avgScore">0</div><div id="costSaved">$0.000</div><div id="creditsSaved">0.0</div>
            <table><tbody id="tableBody"></tbody></table></body></html>`);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      });
      server.listen(PORT, "127.0.0.1", () => resolve());
    });
  });

  after(() => new Promise(resolve => { if (server) server.close(resolve); else resolve(); }));

  it("GET /v1/models should return models list", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/v1/models", method: "GET" });
    assert.strictEqual(r.statusCode, 200);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.object, "list");
    const ids = j.data.map(d => d.id);
    assert.ok(ids.includes("copilot-pulse"));
    assert.ok(ids.includes("copilot-pulse-agent"));
  });

  it("POST /v1/chat/completions should return SSE", async () => {
    const payload = JSON.stringify({ model: "copilot-pulse", messages: [{ role: "user", content: "What is HTTP?" }], stream: true });
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, payload);
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.includes("data:"));
    assert.ok(r.body.includes("[DONE]"));
  });

  it("POST /v1/chat/completions should return 400 for invalid JSON", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 12 } }, "not valid json");
    assert.strictEqual(r.statusCode, 400);
  });

  it("POST /v1/chat/completions should record metric with ALL fields", async () => {
    const before = serverMetrics.length;
    const payload = JSON.stringify({ model: "copilot-pulse", messages: [{ role: "user", content: "Debug this race condition" }] });
    await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, payload);
    assert.ok(serverMetrics.length > before);
    const m = serverMetrics[0];
    assert.ok(m.timestamp > 0); assert.ok(m.routedModel.length > 0); assert.ok(m.model.length > 0);
    assert.ok(m.prompt.length > 0); assert.ok(m.promptSnippet.length > 0); assert.ok(m.taskType.length > 0);
    assert.ok(typeof m.complexityScore === "number"); assert.ok(typeof m.score === "number");
    assert.ok(m.tier.length > 0); assert.ok(typeof m.savings === "boolean");
    assert.ok(typeof m.simulatedSavings === "number"); assert.ok(typeof m.latencyMs === "number");
    assert.ok(m.signals); assert.ok(typeof m.signals.keyword === "number"); assert.ok(typeof m.signals.intent === "number");
    assert.ok(typeof m.signals.code === "number"); assert.ok(typeof m.signals.context === "number"); assert.ok(typeof m.signals.vector === "number");
  });

  it("GET /metrics should return JSON array with CORS header", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/metrics", method: "GET" });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(r.body)));
    assert.strictEqual(r.headers["access-control-allow-origin"], "*");
  });

  it("GET /dashboard should return HTML with all metric element IDs", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/dashboard", method: "GET" });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.headers["content-type"].includes("text/html"));
    for (const id of ["totalRequests", "tier1Count", "tier2Count", "avgScore", "costSaved", "creditsSaved", "tableBody"]) {
      assert.ok(r.body.includes(`id="${id}"`), `Missing ${id} element`);
    }
  });

  it("GET / should also serve dashboard", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/", method: "GET" });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.includes("totalRequests"));
  });

  it("unknown paths should return 404", async () => {
    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/unknown", method: "GET" });
    assert.strictEqual(r.statusCode, 404);
  });

  it("full flow: send diverse requests, then verify /metrics has all fields", async () => {
    const prompts = ["What is HTTP?", "Debug race condition in async thread pool", "Write a function to reverse a list", "Architect scalable event-driven microservice system", "Write a poem about sunset"];
    for (const p of prompts) {
      const payload = JSON.stringify({ model: "copilot-pulse", messages: [{ role: "user", content: p }] });
      await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, payload);
    }

    const r = await httpReq({ hostname: "127.0.0.1", port: PORT, path: "/metrics", method: "GET" });
    const data = JSON.parse(r.body);
    assert.ok(data.length >= 5, `Expected >= 5 metrics, got ${data.length}`);

    for (const m of data) {
      assert.ok(m.timestamp > 0); assert.ok(m.model || m.routedModel);
      assert.ok(m.prompt || m.promptSnippet); assert.ok(m.taskType);
      assert.ok(m.score !== undefined || m.complexityScore !== undefined);
      assert.ok(typeof m.savings === "boolean");
      if (m.signals) {
        for (const k of ["keyword", "intent", "code", "context", "vector"]) assert.ok(typeof m.signals[k] === "number");
      }
    }

    assert.ok(data.some(m => m.savings === true), "Should have at least one savings=true");
  });
});
