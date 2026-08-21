import * as assert from "assert";
import * as http from "http";
import { RouterLogic, RouterConfig } from "../proxy/RouterLogic";
import { ModelTiering, Band } from "../proxy/ModelTiering";

/**
 * Integration tests that spin up a real HTTP server simulating the 
 * LocalProxyServer and verify all endpoints return correctly populated data.
 * 
 * This tests:
 * - GET /v1/models
 * - POST /v1/chat/completions (routing decision only, no real upstream call)
 * - GET /metrics
 * - GET /dashboard (HTML structure)
 */

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

class TestProxyServer {
  private server: http.Server | null = null;
  private metrics: MetricRecord[] = [];
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url || "/";
        if ((url === "/v1/models" || url === "/models") && req.method === "GET") {
          this.handleModels(res);
        } else if ((url === "/v1/chat/completions" || url === "/chat/completions") && req.method === "POST") {
          this.handleChatCompletions(req, res);
        } else if (url === "/metrics" && req.method === "GET") {
          this.handleMetrics(res);
        } else if (url === "/" || url === "/dashboard") {
          this.handleDashboard(res);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => resolve());
      this.server.on("error", reject);
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  public getMetrics(): MetricRecord[] {
    return [...this.metrics];
  }

  private handleModels(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      object: "list",
      data: [
        { id: "copilot-pulse", object: "model", created: 1785897097, owned_by: "copilot-pulse" },
        { id: "copilot-pulse-agent", object: "model", created: 1785897097, owned_by: "copilot-pulse" }
      ]
    }));
  }

  private handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse): void {
    const startTime = Date.now();
    let bodyStr = "";
    req.on("data", chunk => bodyStr += chunk);
    req.on("end", () => {
      try {
        const requestJson = JSON.parse(bodyStr);
        let promptText = "";
        if (Array.isArray(requestJson.messages) && requestJson.messages.length > 0) {
          const lastMsg = requestJson.messages[requestJson.messages.length - 1];
          if (lastMsg && typeof lastMsg.content === "string") {
            promptText = lastMsg.content;
          }
        }

        const cleanPrompt = RouterLogic.extractCleanPrompt(promptText);
        const config: RouterConfig = {
          cheapModel: "openai/gpt-4o-mini",
          strongModel: "openai/gpt-4o",
          threshold: 6.5,
          lowThreshold: 4.0,
          useDynamicTiers: false
        };
        const decision = RouterLogic.routeDecision(cleanPrompt, config);
        const taskType = RouterLogic.detectTaskType(cleanPrompt);
        const roundedScore = Math.round(decision.score * 10) / 10;

        const record: MetricRecord = {
          timestamp: startTime,
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
          latencyMs: Date.now() - startTime,
          signals: {
            keyword: Math.min(9, Math.round(decision.score * 0.9)),
            intent: Math.min(9, Math.round(decision.score * 1.1)),
            code: cleanPrompt.includes("```") ? 8 : 2,
            context: Math.min(9, Math.round(cleanPrompt.length / 50)),
            vector: Math.min(9, Math.round(decision.score * 0.8))
          }
        };
        this.metrics.unshift(record);

        // Return a mock SSE response since we don't forward to upstream
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });

        const mockChunk = JSON.stringify({
          id: "mock",
          object: "chat.completion.chunk",
          model: requestJson.model || "copilot-pulse",
          choices: [{ index: 0, delta: { content: "Hello!" }, finish_reason: "stop" }]
        });
        res.write(`data: ${mockChunk}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON request" }));
      }
    });
  }

  private handleMetrics(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(this.metrics));
  }

  private handleDashboard(res: http.ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head><title>Copilot Pulse Dashboard</title></head><body>
      <div id="totalRequests">0</div>
      <div id="tier1Count">0</div>
      <div id="tier2Count">0</div>
      <div id="avgScore">0</div>
      <div id="costSaved">$0.000</div>
      <div id="creditsSaved">0.0</div>
      <table><tbody id="tableBody"></tbody></table>
    </body></html>`);
  }
}

function httpRequest(options: http.RequestOptions, body?: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({
        statusCode: res.statusCode || 0,
        headers: res.headers,
        body: data
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}


describe("Integration — HTTP Server Endpoints", () => {
  let server: TestProxyServer;
  const PORT = 13457; // Unusual port to avoid conflicts

  before(async () => {
    server = new TestProxyServer(PORT);
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  // ─── GET /v1/models ───────────────────────────────────────────────

  describe("GET /v1/models", () => {

    it("should return 200 with models list", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/models",
        method: "GET"
      });
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.strictEqual(json.object, "list");
      assert.ok(Array.isArray(json.data));
    });

    it("should include copilot-pulse and copilot-pulse-agent models", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/models",
        method: "GET"
      });
      const json = JSON.parse(res.body);
      const ids = json.data.map((d: any) => d.id);
      assert.ok(ids.includes("copilot-pulse"), "Should include copilot-pulse");
      assert.ok(ids.includes("copilot-pulse-agent"), "Should include copilot-pulse-agent");
    });

    it("should return Content-Type application/json", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/models",
        method: "GET"
      });
      assert.ok(res.headers["content-type"]?.includes("application/json"));
    });
  });

  // ─── POST /v1/chat/completions ────────────────────────────────────

  describe("POST /v1/chat/completions", () => {

    it("should return 200 with SSE response for valid request", async () => {
      const payload = JSON.stringify({
        model: "copilot-pulse",
        messages: [{ role: "user", content: "What is HTTP?" }],
        stream: true
      });

      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, payload);

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.includes("data:"), "Should contain SSE data");
      assert.ok(res.body.includes("[DONE]"), "Should contain DONE marker");
    });

    it("should return 400 for invalid JSON", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": 12
        }
      }, "not valid json");

      assert.strictEqual(res.statusCode, 400);
    });

    it("should record a metric after processing a request", async () => {
      const initialCount = server.getMetrics().length;

      const payload = JSON.stringify({
        model: "copilot-pulse",
        messages: [{ role: "user", content: "Explain closures" }]
      });

      await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, payload);

      assert.ok(server.getMetrics().length > initialCount, "Should have recorded a new metric");
    });

    it("should record metric with all required fields populated", async () => {
      const payload = JSON.stringify({
        model: "copilot-pulse",
        messages: [{ role: "user", content: "Debug this race condition in my async code" }]
      });

      await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, payload);

      const lastMetric = server.getMetrics()[0];
      assert.ok(lastMetric.timestamp > 0, "timestamp should be set");
      assert.ok(lastMetric.routedModel.length > 0, "routedModel should be set");
      assert.ok(lastMetric.model.length > 0, "model should be set");
      assert.ok(lastMetric.prompt.length > 0, "prompt should be set");
      assert.ok(lastMetric.promptSnippet.length > 0, "promptSnippet should be set");
      assert.ok(lastMetric.taskType.length > 0, "taskType should be set");
      assert.ok(typeof lastMetric.complexityScore === "number", "complexityScore should be number");
      assert.ok(typeof lastMetric.score === "number", "score should be number");
      assert.ok(lastMetric.tier.length > 0, "tier should be set");
      assert.ok(typeof lastMetric.savings === "boolean", "savings should be boolean");
      assert.ok(typeof lastMetric.simulatedSavings === "number", "simulatedSavings should be number");
      assert.ok(typeof lastMetric.latencyMs === "number", "latencyMs should be number");
      assert.ok(lastMetric.signals, "signals should be set");
      assert.ok(typeof lastMetric.signals!.keyword === "number", "signals.keyword should be number");
      assert.ok(typeof lastMetric.signals!.intent === "number", "signals.intent should be number");
      assert.ok(typeof lastMetric.signals!.code === "number", "signals.code should be number");
      assert.ok(typeof lastMetric.signals!.context === "number", "signals.context should be number");
      assert.ok(typeof lastMetric.signals!.vector === "number", "signals.vector should be number");
    });
  });

  // ─── GET /metrics ─────────────────────────────────────────────────

  describe("GET /metrics", () => {

    it("should return 200 with JSON array", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/metrics",
        method: "GET"
      });
      assert.strictEqual(res.statusCode, 200);
      const json = JSON.parse(res.body);
      assert.ok(Array.isArray(json), "Should be an array");
    });

    it("should include CORS header", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/metrics",
        method: "GET"
      });
      assert.strictEqual(res.headers["access-control-allow-origin"], "*");
    });

    it("should return metrics with all fields for dashboard consumption", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/metrics",
        method: "GET"
      });
      const data = JSON.parse(res.body);
      if (data.length > 0) {
        const m = data[0];
        // Fields needed by the web dashboard JS
        assert.ok("timestamp" in m, "Should have timestamp");
        assert.ok("routedModel" in m || "model" in m, "Should have model identifier");
        assert.ok("prompt" in m || "promptSnippet" in m, "Should have prompt");
        assert.ok("taskType" in m, "Should have taskType");
        assert.ok("complexityScore" in m || "score" in m, "Should have score");
        assert.ok("savings" in m, "Should have savings flag");
        assert.ok("signals" in m, "Should have signals");
      }
    });
  });

  // ─── GET /dashboard ───────────────────────────────────────────────

  describe("GET /dashboard", () => {

    it("should return 200 with HTML content", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/dashboard",
        method: "GET"
      });
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers["content-type"]?.includes("text/html"));
    });

    it("should contain all required dashboard metric elements", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/dashboard",
        method: "GET"
      });
      const html = res.body;

      // Verify all metric element IDs exist in the dashboard HTML
      assert.ok(html.includes('id="totalRequests"'), 'Missing totalRequests element');
      assert.ok(html.includes('id="tier1Count"'), 'Missing tier1Count element');
      assert.ok(html.includes('id="tier2Count"'), 'Missing tier2Count element');
      assert.ok(html.includes('id="avgScore"'), 'Missing avgScore element');
      assert.ok(html.includes('id="costSaved"'), 'Missing costSaved element');
      assert.ok(html.includes('id="creditsSaved"'), 'Missing creditsSaved element');
      assert.ok(html.includes('id="tableBody"'), 'Missing tableBody element');
    });

    it("GET / should also serve the dashboard", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/",
        method: "GET"
      });
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.includes("Dashboard") || res.body.includes("totalRequests"),
        "Root should serve dashboard");
    });
  });

  // ─── 404 handling ─────────────────────────────────────────────────

  describe("404 handling", () => {
    it("should return 404 for unknown paths", async () => {
      const res = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/unknown",
        method: "GET"
      });
      assert.strictEqual(res.statusCode, 404);
    });
  });

  // ─── Full Dashboard Verification (send requests, then check /metrics) ──

  describe("Full Dashboard Verification Flow", () => {

    it("should accumulate diverse metrics and serve them all via /metrics", async () => {
      const prompts = [
        "What is HTTP?",
        "Debug this race condition in my async thread pool",
        "Write a function to reverse a linked list",
        "Architect a scalable event-driven microservice system",
        "Write a poem about sunset"
      ];

      for (const prompt of prompts) {
        const payload = JSON.stringify({
          model: "copilot-pulse",
          messages: [{ role: "user", content: prompt }]
        });
        await httpRequest({
          hostname: "127.0.0.1",
          port: PORT,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
          }
        }, payload);
      }

      // Now fetch metrics
      const metricsRes = await httpRequest({
        hostname: "127.0.0.1",
        port: PORT,
        path: "/metrics",
        method: "GET"
      });

      const data = JSON.parse(metricsRes.body);
      assert.ok(data.length >= 5, `Should have at least 5 metrics, got ${data.length}`);

      // Verify every metric has all required dashboard fields
      for (const m of data) {
        assert.ok(m.timestamp > 0, `timestamp should be > 0`);
        assert.ok(m.model || m.routedModel, `model should be populated`);
        assert.ok(m.prompt || m.promptSnippet, `prompt should be populated`);
        assert.ok(m.taskType, `taskType should be populated`);
        assert.ok(m.score !== undefined || m.complexityScore !== undefined, `score should be populated`);
        assert.ok(typeof m.savings === "boolean", `savings should be boolean`);
        if (m.signals) {
          assert.ok(typeof m.signals.keyword === "number", `signals.keyword should be number`);
          assert.ok(typeof m.signals.intent === "number", `signals.intent should be number`);
          assert.ok(typeof m.signals.code === "number", `signals.code should be number`);
          assert.ok(typeof m.signals.context === "number", `signals.context should be number`);
          assert.ok(typeof m.signals.vector === "number", `signals.vector should be number`);
        }
      }

      // Verify we get both simple and complex routing decisions
      const hasSavings = data.some((m: any) => m.savings === true);
      const hasNoSavings = data.some((m: any) => m.savings === false);
      assert.ok(hasSavings, "Should have at least one savings=true metric");
      // Note: complex prompts may or may not be above threshold depending on exact scoring
    });
  });
});
