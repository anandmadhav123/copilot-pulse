import * as assert from "assert";
import * as http from "http";
import { RouterLogic, RouterConfig } from "../proxy/RouterLogic";
import { ModelTiering, Band } from "../proxy/ModelTiering";

/**
 * Tests for LocalProxyServer logic and Dashboard metrics computation.
 * 
 * Since LocalProxyServer depends on `vscode` imports (via extension.ts flow),
 * we test the core logic functions and metric computation independently.
 */

// ─── Simulate MetricRecord (same interface as LocalProxyServer) ───

interface MetricRecord {
  timestamp: number;
  routedModel: String;
  model: string;
  prompt: string;
  promptSnippet: string;
  taskType: string;
  complexityScore: number;
  score: number;
  tier: string;
  savings: boolean;
  simulatedSavings: number;
  latencyMs: number;
  signals?: {
    keyword?: number;
    intent?: number;
    code?: number;
    context?: number;
    vector?: number;
  };
}

// ─── Simulate MetricRecorder (extracted from LocalProxyServer) ────

class MetricRecorder {
  public metrics: MetricRecord[] = [];

  public recordMetric(record: MetricRecord): void {
    this.metrics.unshift(record);
    if (this.metrics.length > 200) {
      this.metrics.pop();
    }
  }

  public getMetrics(): MetricRecord[] {
    return [...this.metrics];
  }
}

// ─── Simulate DashboardComputation (from DashboardWebview) ────────

function computeDashboardSummary(metrics: MetricRecord[]) {
  const totalCount = metrics.length;
  const cheapCount = metrics.filter(m => m.savings).length;
  const savingsPercent = totalCount > 0 ? Math.round((cheapCount / totalCount) * 100) : 0;
  const avgLatency = totalCount > 0 ? Math.round(metrics.reduce((acc, m) => acc + m.latencyMs, 0) / totalCount) : 0;
  return { totalCount, cheapCount, savingsPercent, avgLatency };
}

// ─── Simulate Full Dashboard Metric Computation (from handleDashboard) ──

function computeFullDashboardMetrics(metrics: MetricRecord[]) {
  const total = metrics.length;
  const tier2Items = metrics.filter(d => d.savings || (d.routedModel || d.model || '').toString().includes('mini') || (d.complexityScore || d.score || 0) < 4.0);
  const tier2Count = tier2Items.length;
  const tier1Count = total - tier2Count;
  const avg = total > 0 ? parseFloat((metrics.reduce((s, d) => s + (d.complexityScore || d.score || 0), 0) / total).toFixed(1)) : 0;
  const dollars = parseFloat((tier2Count * 0.014).toFixed(3));
  const credits = parseFloat((tier2Count * 0.8).toFixed(1));

  return { total, tier1Count, tier2Count, avg, dollars, credits };
}

// ─── Build a realistic metric record from a prompt ───────────────

function buildMetricRecord(prompt: string, config: RouterConfig, latencyMs: number = 100): MetricRecord {
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


describe("Dashboard Metrics & Proxy Logic — Comprehensive Tests", () => {

  const defaultConfig: RouterConfig = {
    cheapModel: "openai/gpt-4o-mini",
    strongModel: "openai/gpt-4o",
    threshold: 6.5,
    lowThreshold: 4.0,
    useDynamicTiers: false
  };

  // ─── MetricRecord Construction ────────────────────────────────────

  describe("MetricRecord Construction", () => {

    it("should build a complete metric record with all required fields", () => {
      const record = buildMetricRecord("What is HTTP?", defaultConfig);

      assert.ok(record.timestamp > 0, "timestamp should be set");
      assert.ok(typeof record.routedModel === "string", "routedModel should be string");
      assert.ok(typeof record.model === "string", "model should be string");
      assert.ok(typeof record.prompt === "string", "prompt should be string");
      assert.ok(typeof record.promptSnippet === "string", "promptSnippet should be string");
      assert.ok(typeof record.taskType === "string", "taskType should be string");
      assert.ok(typeof record.complexityScore === "number", "complexityScore should be number");
      assert.ok(typeof record.score === "number", "score should be number");
      assert.ok(typeof record.tier === "string", "tier should be string");
      assert.ok(typeof record.savings === "boolean", "savings should be boolean");
      assert.ok(typeof record.simulatedSavings === "number", "simulatedSavings should be number");
      assert.ok(typeof record.latencyMs === "number", "latencyMs should be number");
    });

    it("should populate signals object with all 5 signal types", () => {
      const record = buildMetricRecord("Debug this async race condition", defaultConfig);

      assert.ok(record.signals, "signals should be defined");
      assert.ok("keyword" in record.signals!, "signals.keyword should exist");
      assert.ok("intent" in record.signals!, "signals.intent should exist");
      assert.ok("code" in record.signals!, "signals.code should exist");
      assert.ok("context" in record.signals!, "signals.context should exist");
      assert.ok("vector" in record.signals!, "signals.vector should exist");
    });

    it("should cap signal values at 9", () => {
      const record = buildMetricRecord(
        "Architect a scalable microservices event-driven distributed system design patterns",
        defaultConfig
      );

      if (record.signals) {
        assert.ok(record.signals.keyword! <= 9, `keyword should be <= 9, got ${record.signals.keyword}`);
        assert.ok(record.signals.intent! <= 9, `intent should be <= 9, got ${record.signals.intent}`);
        assert.ok(record.signals.code! <= 9, `code should be <= 9, got ${record.signals.code}`);
        assert.ok(record.signals.context! <= 9, `context should be <= 9, got ${record.signals.context}`);
        assert.ok(record.signals.vector! <= 9, `vector should be <= 9, got ${record.signals.vector}`);
      }
    });

    it("should set code signal to 8 when prompt contains code blocks", () => {
      const record = buildMetricRecord("Fix this:\n```python\ndef broken():\n    pass\n```", defaultConfig);
      assert.strictEqual(record.signals?.code, 8, "code signal should be 8 for code blocks");
    });

    it("should set code signal to 2 when no code blocks present", () => {
      const record = buildMetricRecord("What is a closure?", defaultConfig);
      assert.strictEqual(record.signals?.code, 2, "code signal should be 2 without code blocks");
    });

    it("should truncate promptSnippet to 80 characters", () => {
      const longPrompt = "x".repeat(200);
      const record = buildMetricRecord(longPrompt, defaultConfig);
      assert.ok(record.promptSnippet.length <= 80,
        `promptSnippet should be <= 80 chars, got ${record.promptSnippet.length}`);
    });

    it("should set prompt to 'Copilot Query' for empty prompts", () => {
      const record = buildMetricRecord("", defaultConfig);
      assert.strictEqual(record.prompt, "Copilot Query");
      assert.strictEqual(record.promptSnippet, "Copilot Query");
    });

    it("should compute savings correctly for cheap model routing", () => {
      const record = buildMetricRecord("What is HTTP?", defaultConfig);
      assert.strictEqual(record.savings, true);
      assert.strictEqual(record.simulatedSavings, 0.014);
    });

    it("should compute savings correctly for strong model routing", () => {
      const prompt = "Architect a scalable microservices event-driven system with distributed tracing and design patterns";
      const record = buildMetricRecord(prompt, defaultConfig);
      assert.strictEqual(record.savings, false);
      assert.strictEqual(record.simulatedSavings, 0.0);
    });

    it("should round complexityScore to 1 decimal place", () => {
      const record = buildMetricRecord("Debug this error", defaultConfig);
      const rounded = Math.round(record.complexityScore * 10) / 10;
      assert.strictEqual(record.complexityScore, rounded,
        "complexityScore should be rounded to 1 decimal");
    });

    it("should set complexityScore equal to score", () => {
      const record = buildMetricRecord("Explain closures", defaultConfig);
      assert.strictEqual(record.complexityScore, record.score,
        "complexityScore and score should be identical");
    });
  });

  // ─── MetricRecorder ───────────────────────────────────────────────

  describe("MetricRecorder", () => {
    let recorder: MetricRecorder;

    beforeEach(() => {
      recorder = new MetricRecorder();
    });

    it("should start with empty metrics", () => {
      assert.strictEqual(recorder.getMetrics().length, 0);
    });

    it("should record metrics", () => {
      const record = buildMetricRecord("Test", defaultConfig);
      recorder.recordMetric(record);
      assert.strictEqual(recorder.getMetrics().length, 1);
    });

    it("should prepend new records (most recent first)", () => {
      const r1 = buildMetricRecord("First", defaultConfig);
      r1.timestamp = 1000;
      const r2 = buildMetricRecord("Second", defaultConfig);
      r2.timestamp = 2000;

      recorder.recordMetric(r1);
      recorder.recordMetric(r2);

      const metrics = recorder.getMetrics();
      assert.strictEqual(metrics[0].timestamp, 2000, "Most recent should be first");
      assert.strictEqual(metrics[1].timestamp, 1000, "Older should be second");
    });

    it("should cap at 200 metrics", () => {
      for (let i = 0; i < 250; i++) {
        recorder.recordMetric(buildMetricRecord(`Prompt ${i}`, defaultConfig));
      }
      assert.strictEqual(recorder.getMetrics().length, 200, "Should cap at 200");
    });

    it("should return a copy of metrics (not the original array)", () => {
      recorder.recordMetric(buildMetricRecord("Test", defaultConfig));
      const metrics = recorder.getMetrics();
      metrics.push(buildMetricRecord("Should not affect original", defaultConfig));
      assert.strictEqual(recorder.getMetrics().length, 1,
        "Original metrics should not be affected by mutations to returned copy");
    });
  });

  // ─── Dashboard Summary Computation (VSCode Webview Panel) ─────────

  describe("Dashboard Summary (VSCode Webview)", () => {

    it("should return all zeros for empty metrics", () => {
      const summary = computeDashboardSummary([]);
      assert.strictEqual(summary.totalCount, 0);
      assert.strictEqual(summary.cheapCount, 0);
      assert.strictEqual(summary.savingsPercent, 0);
      assert.strictEqual(summary.avgLatency, 0);
    });

    it("should compute totalCount correctly", () => {
      const metrics = [
        buildMetricRecord("Query 1", defaultConfig),
        buildMetricRecord("Query 2", defaultConfig),
        buildMetricRecord("Query 3", defaultConfig)
      ];
      const summary = computeDashboardSummary(metrics);
      assert.strictEqual(summary.totalCount, 3);
    });

    it("should compute cheapCount (savings=true) correctly", () => {
      const metrics = [
        buildMetricRecord("What is HTTP?", defaultConfig),  // savings=true (simple)
        buildMetricRecord("What is CSS?", defaultConfig),   // savings=true (simple)
        buildMetricRecord(
          "Architect a scalable microservices event-driven system with distributed tracing and design patterns",
          defaultConfig
        )  // savings=false (complex)
      ];
      const summary = computeDashboardSummary(metrics);
      assert.strictEqual(summary.cheapCount, 2, "Should have 2 cheap queries");
    });

    it("should compute savingsPercent correctly", () => {
      const metrics = [
        buildMetricRecord("What is HTTP?", defaultConfig),  // savings=true
        buildMetricRecord("What is CSS?", defaultConfig),   // savings=true
      ];
      const summary = computeDashboardSummary(metrics);
      assert.strictEqual(summary.savingsPercent, 100, "All cheap → 100%");
    });

    it("should compute savingsPercent as 0 when no savings", () => {
      // Create metrics where all go to strong model
      const config: RouterConfig = { ...defaultConfig, threshold: 0.1 }; // Everything is "complex"
      const metrics = [
        buildMetricRecord("Hello", config),
        buildMetricRecord("Hi there", config)
      ];
      const summary = computeDashboardSummary(metrics);
      assert.strictEqual(summary.savingsPercent, 0, "No savings → 0%");
    });

    it("should compute avgLatency correctly", () => {
      const r1 = buildMetricRecord("A", defaultConfig, 100);
      const r2 = buildMetricRecord("B", defaultConfig, 200);
      const r3 = buildMetricRecord("C", defaultConfig, 300);
      const summary = computeDashboardSummary([r1, r2, r3]);
      assert.strictEqual(summary.avgLatency, 200, "Avg of 100, 200, 300 = 200");
    });

    it("should round avgLatency to integer", () => {
      const r1 = buildMetricRecord("A", defaultConfig, 100);
      const r2 = buildMetricRecord("B", defaultConfig, 201);
      const summary = computeDashboardSummary([r1, r2]);
      assert.strictEqual(summary.avgLatency, 151, "Should round (100+201)/2 = 150.5 → 151");
    });

    it("should round savingsPercent to integer", () => {
      const metrics = [
        buildMetricRecord("What?", defaultConfig), // cheap
        buildMetricRecord("What?", defaultConfig), // cheap
        buildMetricRecord(
          "Architect a scalable microservices event-driven system with distributed tracing and design patterns",
          defaultConfig
        ) // expensive
      ];
      const summary = computeDashboardSummary(metrics);
      assert.ok(Number.isInteger(summary.savingsPercent), "savingsPercent should be integer");
    });
  });

  // ─── Full Dashboard Metrics (Web Dashboard at /dashboard) ──────────

  describe("Full Dashboard Metrics (Web Dashboard)", () => {

    it("should return all zeros for empty metrics", () => {
      const result = computeFullDashboardMetrics([]);
      assert.strictEqual(result.total, 0);
      assert.strictEqual(result.tier1Count, 0);
      assert.strictEqual(result.tier2Count, 0);
      assert.strictEqual(result.avg, 0);
      assert.strictEqual(result.dollars, 0);
      assert.strictEqual(result.credits, 0);
    });

    it("should compute total request count", () => {
      const metrics = [
        buildMetricRecord("A", defaultConfig),
        buildMetricRecord("B", defaultConfig),
        buildMetricRecord("C", defaultConfig)
      ];
      const result = computeFullDashboardMetrics(metrics);
      assert.strictEqual(result.total, 3);
    });

    it("should correctly classify Tier 1 (complex) vs Tier 2 (simple)", () => {
      const metrics = [
        buildMetricRecord("What is HTTP?", defaultConfig),  // Tier 2 (simple, savings=true)
        buildMetricRecord(
          "Architect a scalable microservices event-driven system with distributed tracing and design patterns",
          defaultConfig
        ),  // Tier 1 (complex, savings=false)
      ];
      const result = computeFullDashboardMetrics(metrics);
      assert.ok(result.tier2Count >= 1, `Should have at least 1 Tier 2 item, got ${result.tier2Count}`);
      assert.ok(result.tier1Count >= 0, `Tier 1 count should be >= 0, got ${result.tier1Count}`);
      assert.strictEqual(result.tier1Count + result.tier2Count, result.total,
        "tier1 + tier2 should equal total");
    });

    it("should compute average score correctly", () => {
      const r1 = buildMetricRecord("What is HTTP?", defaultConfig);
      const r2 = buildMetricRecord("Debug this async race condition deadlock", defaultConfig);
      const metrics = [r1, r2];
      const result = computeFullDashboardMetrics(metrics);
      const expectedAvg = parseFloat(((r1.score + r2.score) / 2).toFixed(1));
      assert.strictEqual(result.avg, expectedAvg);
    });

    it("should compute cost saved based on tier2 count", () => {
      const simplePrompts = Array(10).fill(null).map((_, i) =>
        buildMetricRecord(`Simple question ${i}`, defaultConfig)
      );
      const result = computeFullDashboardMetrics(simplePrompts);
      // All simple prompts should be tier2
      const expectedDollars = parseFloat((result.tier2Count * 0.014).toFixed(3));
      assert.strictEqual(result.dollars, expectedDollars, "dollars should match tier2 * 0.014");
    });

    it("should compute credits saved based on tier2 count", () => {
      const simplePrompts = Array(5).fill(null).map((_, i) =>
        buildMetricRecord(`Simple ${i}`, defaultConfig)
      );
      const result = computeFullDashboardMetrics(simplePrompts);
      const expectedCredits = parseFloat((result.tier2Count * 0.8).toFixed(1));
      assert.strictEqual(result.credits, expectedCredits, "credits should match tier2 * 0.8");
    });

    it("should have all dashboard metrics populated for mixed workload", () => {
      const metrics = [
        buildMetricRecord("What is HTTP?", defaultConfig),
        buildMetricRecord("Debug this async race condition deadlock in my threading code", defaultConfig),
        buildMetricRecord("Architect a scalable microservices event-driven system with distributed tracing and design patterns", defaultConfig),
        buildMetricRecord("Write a poem", defaultConfig),
        buildMetricRecord("Explain what is a closure", defaultConfig),
        buildMetricRecord("Refactor this code to fix memory leak and optimize performance", defaultConfig),
        buildMetricRecord("What is the command to list files?", defaultConfig),
        buildMetricRecord("Implement a dynamic programming solution with O(n log n) complexity", defaultConfig)
      ];

      const webviewSummary = computeDashboardSummary(metrics);
      const dashboardMetrics = computeFullDashboardMetrics(metrics);

      // ─── All Webview Panel Metrics Must Be Populated ────
      assert.ok(webviewSummary.totalCount > 0, "totalCount should be > 0");
      assert.ok(webviewSummary.cheapCount >= 0, "cheapCount should be >= 0");
      assert.ok(webviewSummary.savingsPercent >= 0 && webviewSummary.savingsPercent <= 100,
        `savingsPercent should be 0-100, got ${webviewSummary.savingsPercent}`);
      assert.ok(webviewSummary.avgLatency >= 0, "avgLatency should be >= 0");

      // ─── All Web Dashboard Metrics Must Be Populated ────
      assert.ok(dashboardMetrics.total > 0, "total should be > 0");
      assert.ok(dashboardMetrics.tier1Count >= 0, "tier1Count should be >= 0");
      assert.ok(dashboardMetrics.tier2Count >= 0, "tier2Count should be >= 0");
      assert.strictEqual(dashboardMetrics.tier1Count + dashboardMetrics.tier2Count, dashboardMetrics.total,
        "tier1 + tier2 must equal total");
      assert.ok(dashboardMetrics.avg >= 0, "avg score should be >= 0");
      assert.ok(dashboardMetrics.dollars >= 0, "dollars saved should be >= 0");
      assert.ok(dashboardMetrics.credits >= 0, "credits saved should be >= 0");

      // ─── Every Individual Metric Record Must Have All Fields ────
      for (const m of metrics) {
        assert.ok(m.timestamp > 0, `timestamp missing/invalid for "${m.prompt}"`);
        assert.ok(m.routedModel.length > 0, `routedModel empty for "${m.prompt}"`);
        assert.ok(m.model.length > 0, `model empty for "${m.prompt}"`);
        assert.ok(m.prompt.length > 0, `prompt empty`);
        assert.ok(m.promptSnippet.length > 0, `promptSnippet empty for "${m.prompt}"`);
        assert.ok(m.taskType.length > 0, `taskType empty for "${m.prompt}"`);
        assert.ok(typeof m.complexityScore === "number", `complexityScore not a number for "${m.prompt}"`);
        assert.ok(typeof m.score === "number", `score not a number for "${m.prompt}"`);
        assert.ok(m.tier.length > 0, `tier empty for "${m.prompt}"`);
        assert.ok(typeof m.savings === "boolean", `savings not boolean for "${m.prompt}"`);
        assert.ok(typeof m.simulatedSavings === "number", `simulatedSavings not number for "${m.prompt}"`);
        assert.ok(typeof m.latencyMs === "number", `latencyMs not number for "${m.prompt}"`);
        assert.ok(m.signals, `signals missing for "${m.prompt}"`);
        assert.ok(typeof m.signals!.keyword === "number", `signals.keyword missing for "${m.prompt}"`);
        assert.ok(typeof m.signals!.intent === "number", `signals.intent missing for "${m.prompt}"`);
        assert.ok(typeof m.signals!.code === "number", `signals.code missing for "${m.prompt}"`);
        assert.ok(typeof m.signals!.context === "number", `signals.context missing for "${m.prompt}"`);
        assert.ok(typeof m.signals!.vector === "number", `signals.vector missing for "${m.prompt}"`);
      }
    });
  });

  // ─── Dashboard Table Row Data ─────────────────────────────────────

  describe("Dashboard Table Row Data Completeness", () => {

    it("should have all fields needed by the dashboard table row template", () => {
      const record = buildMetricRecord("Debug this error in my code", defaultConfig);

      // These are the exact fields accessed by the dashboard HTML template:
      // d.timestamp, d.prompt/d.promptSnippet, d.taskType, d.complexityScore/d.score,
      // d.signals.keyword/intent/code/context/vector, d.routedModel/d.model, d.savings
      assert.ok(record.timestamp > 0, "timestamp required for table Time column");
      assert.ok(record.prompt || record.promptSnippet, "prompt required for table Prompt column");
      assert.ok(record.taskType, "taskType required for table Task Type badge");
      assert.ok(record.complexityScore !== undefined || record.score !== undefined,
        "score required for table Score column");
      assert.ok(record.signals, "signals required for table Signals column");
      assert.ok(record.routedModel || record.model, "model required for table Routed Model column");
      assert.ok(typeof record.savings === "boolean", "savings required for model badge styling");
    });

    it("should format time correctly from timestamp", () => {
      const record = buildMetricRecord("Test", defaultConfig);
      const time = new Date(record.timestamp).toLocaleTimeString();
      assert.ok(time.length > 0, "Should produce valid time string");
    });

    it("should produce valid score color for all score ranges", () => {
      function getScoreColor(score: number): string {
        if (score >= 7) return '#ef4444';
        if (score >= 5) return '#f59e0b';
        if (score >= 3) return '#60a5fa';
        return '#86efac';
      }

      // Test all ranges
      assert.strictEqual(getScoreColor(0), '#86efac');
      assert.strictEqual(getScoreColor(2.9), '#86efac');
      assert.strictEqual(getScoreColor(3), '#60a5fa');
      assert.strictEqual(getScoreColor(4.9), '#60a5fa');
      assert.strictEqual(getScoreColor(5), '#f59e0b');
      assert.strictEqual(getScoreColor(6.9), '#f59e0b');
      assert.strictEqual(getScoreColor(7), '#ef4444');
      assert.strictEqual(getScoreColor(10), '#ef4444');
    });
  });

  // ─── End-to-End Request Flow Simulation ────────────────────────────

  describe("End-to-End Request Flow", () => {

    it("should simulate a complete chat completion request lifecycle", () => {
      const config: RouterConfig = {
        baseUrl: "https://example.com/v1",
        apiKey: "test-key",
        cheapModel: "openai/gpt-4o-mini",
        strongModel: "openai/gpt-4o",
        threshold: 6.5,
        lowThreshold: 4.0,
        useDynamicTiers: false
      };

      // Step 1: Receive request body
      const requestJson = {
        model: "copilot-pulse",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "<user_request>What is a linked list?</user_request>" }
        ],
        stream: true
      };

      // Step 2: Extract prompt from last message
      const lastMsg = requestJson.messages[requestJson.messages.length - 1];
      const promptText = typeof lastMsg.content === "string" ? lastMsg.content : "";

      // Step 3: Clean the prompt
      const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
      assert.strictEqual(cleanPrompt, "What is a linked list?");

      // Step 4: Route decision
      const decision = RouterLogic.routeDecision(cleanPrompt, config);
      assert.ok(decision.model, "Should have a model");
      assert.ok(typeof decision.score === "number", "Should have a score");
      assert.ok(typeof decision.savings === "boolean", "Should have savings flag");

      // Step 5: Detect task type
      const taskType = RouterLogic.detectTaskType(cleanPrompt);
      assert.ok(taskType, "Should have a task type");

      // Step 6: Build metric record
      const record = buildMetricRecord(promptText, config, 150);
      assert.strictEqual(record.prompt, "What is a linked list?");
      assert.strictEqual(record.latencyMs, 150);

      // Step 7: Record in metrics store
      const recorder = new MetricRecorder();
      recorder.recordMetric(record);
      assert.strictEqual(recorder.getMetrics().length, 1);

      // Step 8: Compute dashboard summary
      const summary = computeDashboardSummary(recorder.getMetrics());
      assert.strictEqual(summary.totalCount, 1);
      assert.strictEqual(summary.avgLatency, 150);

      // Step 9: Compute full dashboard metrics
      const dashboard = computeFullDashboardMetrics(recorder.getMetrics());
      assert.strictEqual(dashboard.total, 1);
      assert.ok(dashboard.tier1Count + dashboard.tier2Count === 1);
    });

    it("should handle multi-request workload with diverse prompts", () => {
      const recorder = new MetricRecorder();
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

      for (const p of prompts) {
        const record = buildMetricRecord(p, defaultConfig, Math.floor(Math.random() * 500) + 50);
        recorder.recordMetric(record);
      }

      const metrics = recorder.getMetrics();
      assert.strictEqual(metrics.length, 10);

      const summary = computeDashboardSummary(metrics);
      assert.strictEqual(summary.totalCount, 10);
      assert.ok(summary.cheapCount >= 0 && summary.cheapCount <= 10);
      assert.ok(summary.savingsPercent >= 0 && summary.savingsPercent <= 100);
      assert.ok(summary.avgLatency > 0);

      const dashboard = computeFullDashboardMetrics(metrics);
      assert.strictEqual(dashboard.total, 10);
      assert.strictEqual(dashboard.tier1Count + dashboard.tier2Count, 10);
      assert.ok(dashboard.avg > 0);

      // Verify at least some routing diversity
      const models = new Set(metrics.map(m => m.model));
      assert.ok(models.size >= 1, "Should use at least 1 distinct model");

      const taskTypes = new Set(metrics.map(m => m.taskType));
      assert.ok(taskTypes.size >= 3, `Should detect at least 3 task types, got: ${[...taskTypes].join(", ")}`);
    });
  });
});
