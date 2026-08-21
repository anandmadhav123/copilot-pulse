import * as assert from "assert";
import { RouterLogic, RouterConfig } from "../proxy/RouterLogic";

describe("RouterLogic — Comprehensive Tests", () => {

  // ─── calculateScore ───────────────────────────────────────────────

  describe("calculateScore", () => {

    it("should return 0 for empty string", () => {
      assert.strictEqual(RouterLogic.calculateScore(""), 0.0);
    });

    it("should return 0 for whitespace-only input", () => {
      assert.strictEqual(RouterLogic.calculateScore("   "), 0.0);
    });

    it("should score simple 'what is X?' questions low (< 4.0)", () => {
      const prompts = [
        "What is a linked list?",
        "How does HTTP work?",
        "Explain what a variable is",
        "What is CSS?",
        "What is an API?"
      ];
      for (const p of prompts) {
        const score = RouterLogic.calculateScore(p);
        assert.ok(score < 4.0, `Expected "${p}" to score < 4.0, got ${score}`);
      }
    });

    it("should score architecture prompts high (>= 6.5)", () => {
      const prompts = [
        "Architect a scalable microservices event-driven system with distributed tracing",
        "Design a system for a high-traffic e-commerce platform with microservice architecture",
        "Compare trade-offs between monolithic and distributed design patterns for scalable systems"
      ];
      for (const p of prompts) {
        const score = RouterLogic.calculateScore(p);
        assert.ok(score >= 6.5, `Expected "${p}" to score >= 6.5, got ${score}`);
      }
    });

    it("should score debugging/refactoring prompts in medium-high range", () => {
      const prompts = [
        "Debug this race condition in my async thread pool implementation",
        "Refactor this code to fix the memory leak and optimize performance",
        "Fix the deadlock in my concurrency implementation and benchmark it"
      ];
      for (const p of prompts) {
        const score = RouterLogic.calculateScore(p);
        assert.ok(score >= 5.0, `Expected "${p}" to score >= 5.0, got ${score}`);
      }
    });

    it("should score mathematical/algorithm prompts high", () => {
      const prompts = [
        "Implement a dynamic programming solution with O(n log n) complexity",
        "Prove the time complexity of binary search is O(log n) using mathematical induction",
        "Design an algorithm using graph theory and recursive backtracking"
      ];
      for (const p of prompts) {
        const score = RouterLogic.calculateScore(p);
        assert.ok(score >= 5.5, `Expected "${p}" to score >= 5.5, got ${score}`);
      }
    });

    it("should score creative/simple prompts low (< 4.0)", () => {
      const prompts = [
        "Write a story about a cat",
        "Brainstorm creative marketing slogans for a blog post",
        "Write a poem about the sunset"
      ];
      for (const p of prompts) {
        const score = RouterLogic.calculateScore(p);
        assert.ok(score < 4.0, `Expected "${p}" to score < 4.0, got ${score}`);
      }
    });

    it("should give higher scores to prompts with code blocks", () => {
      const withoutCode = "Fix this function";
      const withCode = "Fix this function\n```python\ndef broken():\n    return None\n```";
      const scoreWithout = RouterLogic.calculateScore(withoutCode);
      const scoreWith = RouterLogic.calculateScore(withCode);
      assert.ok(scoreWith > scoreWithout,
        `Expected score with code (${scoreWith}) > score without (${scoreWithout})`);
    });

    it("should give higher code score for large code blocks (ratio > 0.6)", () => {
      const longCode = "Fix:\n```js\n" + "x = 1;\n".repeat(100) + "```";
      const shortCode = "Fix:\n```js\nx = 1;\n```";
      const longScore = RouterLogic.calculateScore(longCode);
      const shortScore = RouterLogic.calculateScore(shortCode);
      assert.ok(longScore >= shortScore,
        `Expected long code score (${longScore}) >= short (${shortScore})`);
    });

    it("should detect stack traces/tracebacks and increase score", () => {
      const prompt = 'I get an error:\nTraceback\nFile "test.py", line 42\nRuntimeError: boom';
      const score = RouterLogic.calculateScore(prompt);
      assert.ok(score > 2.0, `Stack trace should bump score, got ${score}`);
    });

    it("should handle very long prompts without crashing", () => {
      const longPrompt = "Explain ".repeat(5000);
      const score = RouterLogic.calculateScore(longPrompt);
      assert.ok(typeof score === "number" && !isNaN(score), "Score should be a valid number");
    });

    it("should cap keyword score at 10.0", () => {
      // Prompt with every keyword from every category
      const prompt = "architect design trade-off tradeoff compare evaluate scale scalable distributed microservice pattern principles best practice refactor debug optimize migrate implement performance memory leak race condition deadlock concurrency async threading benchmark algorithm complexity o(n) o(log proof calculate recursive dynamic programming graph theory binary search sorting big-o mathematical equation explain summarize what is how does why does definition meaning overview introduction brainstorm suggest creative write a story poem blog post marketing slogan";
      const score = RouterLogic.calculateScore(prompt);
      assert.ok(score <= 10.0, `Score should not exceed 10.0, got ${score}`);
    });

    it("should produce consistent scores for the same input", () => {
      const prompt = "Design a microservice architecture with distributed tracing";
      const score1 = RouterLogic.calculateScore(prompt);
      const score2 = RouterLogic.calculateScore(prompt);
      assert.strictEqual(score1, score2, "Same input should produce identical scores");
    });
  });

  // ─── detectTaskType ───────────────────────────────────────────────

  describe("detectTaskType", () => {

    it("should return GENERAL for empty string", () => {
      assert.strictEqual(RouterLogic.detectTaskType(""), "GENERAL");
    });

    it("should detect ARCHITECTURE tasks", () => {
      const prompts = [
        "Architect a scalable system design",
        "Design a cloud architecture with data pipeline",
        "Implement an event-driven microservice deployment strategy"
      ];
      for (const p of prompts) {
        assert.strictEqual(RouterLogic.detectTaskType(p), "ARCHITECTURE",
          `Expected ARCHITECTURE for "${p}"`);
      }
    });

    it("should detect CODE_REFACTORING tasks", () => {
      const prompts = [
        "Refactor this class to follow SOLID principles",
        "Clean up my code and address technical debt",
        "Improve this code to fix the code smell"
      ];
      for (const p of prompts) {
        assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_REFACTORING",
          `Expected CODE_REFACTORING for "${p}"`);
      }
    });

    it("should detect CODE_DEBUGGING tasks", () => {
      const prompts = [
        "Debug this crash in production",
        "Fix this error in my code",
        "My code is not working, I see this stack trace"
      ];
      for (const p of prompts) {
        assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_DEBUGGING",
          `Expected CODE_DEBUGGING for "${p}"`);
      }
    });

    it("should detect MATH_LOGIC tasks", () => {
      const prompts = [
        "What is the time complexity of this algorithm?",
        "Implement dynamic programming with backtracking",
        "Design a data structure with O(log n) insertion"
      ];
      for (const p of prompts) {
        const taskType = RouterLogic.detectTaskType(p);
        assert.ok(taskType === "MATH_LOGIC" || taskType === "ARCHITECTURE",
          `Expected MATH_LOGIC or related for "${p}", got ${taskType}`);
      }
    });

    it("should detect CODE_GENERATION tasks", () => {
      const prompts = [
        "Write a function to sort an array",
        "Create a class for user authentication",
        "Implement a REST API endpoint"
      ];
      for (const p of prompts) {
        assert.strictEqual(RouterLogic.detectTaskType(p), "CODE_GENERATION",
          `Expected CODE_GENERATION for "${p}"`);
      }
    });

    it("should detect EXPLANATION tasks", () => {
      const prompts = [
        "Explain how React hooks work",
        "What is a closure in JavaScript?",
        "Walk me through the TCP handshake"
      ];
      for (const p of prompts) {
        const taskType = RouterLogic.detectTaskType(p);
        assert.ok(taskType === "EXPLANATION" || taskType === "QUICK_LOOKUP",
          `Expected EXPLANATION or QUICK_LOOKUP for "${p}", got ${taskType}`);
      }
    });

    it("should detect CREATIVE_WRITING tasks", () => {
      const prompts = [
        "Write a story about space exploration",
        "Write me a poem about mountains",
        "Draft a marketing copy for our product"
      ];
      for (const p of prompts) {
        assert.strictEqual(RouterLogic.detectTaskType(p), "CREATIVE_WRITING",
          `Expected CREATIVE_WRITING for "${p}"`);
      }
    });

    it("should detect QUICK_LOOKUP tasks", () => {
      const prompts = [
        "What is the command to list files in Linux?",
        "How to install npm in Windows?",
        "What is the syntax for a for loop in Python?"
      ];
      for (const p of prompts) {
        const taskType = RouterLogic.detectTaskType(p);
        assert.ok(
          taskType === "QUICK_LOOKUP" || taskType === "EXPLANATION" || taskType === "CODE_GENERATION",
          `Expected QUICK_LOOKUP/EXPLANATION for "${p}", got ${taskType}`
        );
      }
    });

    it("should fall back to CODE_GENERATION for ambiguous prompts", () => {
      const taskType = RouterLogic.detectTaskType("Please help me with this thing");
      assert.strictEqual(taskType, "CODE_GENERATION",
        "Ambiguous prompt should fall back to CODE_GENERATION");
    });
  });

  // ─── routeDecision ────────────────────────────────────────────────

  describe("routeDecision", () => {

    const defaultConfig: RouterConfig = {
      cheapModel: "openai/gpt-4o-mini",
      strongModel: "openai/gpt-4o",
      threshold: 6.5,
      lowThreshold: 4.0,
      useDynamicTiers: false
    };

    it("should route simple prompts to cheap model", () => {
      const decision = RouterLogic.routeDecision("What is a linked list?", defaultConfig);
      assert.strictEqual(decision.model, "openai/gpt-4o-mini");
      assert.strictEqual(decision.savings, true);
      assert.ok(decision.score < 6.5);
    });

    it("should route complex prompts to strong model", () => {
      const prompt = "Architect a scalable microservices event-driven system to handle race conditions and deadlock under high concurrency with distributed tracing";
      const decision = RouterLogic.routeDecision(prompt, defaultConfig);
      assert.strictEqual(decision.model, "openai/gpt-4o");
      assert.strictEqual(decision.savings, false);
      assert.ok(decision.score >= 6.5, `Expected score >= 6.5, got ${decision.score}`);
    });

    it("should include score, tier, model, and savings in decision", () => {
      const decision = RouterLogic.routeDecision("Hello", defaultConfig);
      assert.ok("model" in decision, "Decision should have 'model'");
      assert.ok("score" in decision, "Decision should have 'score'");
      assert.ok("tier" in decision, "Decision should have 'tier'");
      assert.ok("savings" in decision, "Decision should have 'savings'");
    });

    it("should set tier to 'Strong' for complex prompts (static mode)", () => {
      const prompt = "Architect a scalable microservices event-driven system with distributed tracing and design patterns";
      const decision = RouterLogic.routeDecision(prompt, defaultConfig);
      assert.strictEqual(decision.tier, "Strong");
    });

    it("should set tier to 'Light' for simple prompts (static mode)", () => {
      const decision = RouterLogic.routeDecision("Hello world", defaultConfig);
      assert.strictEqual(decision.tier, "Light");
    });

    it("should use default models when config is undefined", () => {
      const decision = RouterLogic.routeDecision("What is HTTP?");
      assert.ok(
        decision.model === "openai/gpt-4o-mini" || decision.model === "openai/gpt-4o",
        "Should use default models"
      );
    });

    it("should use dynamic tiers when available models are provided", () => {
      const config: RouterConfig = {
        ...defaultConfig,
        useDynamicTiers: true,
        availableModels: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "openai/gpt-4o"]
      };

      const simpleDecision = RouterLogic.routeDecision("What is 2+2?", config);
      assert.ok(simpleDecision.savings, "Simple prompt should yield savings");

      const complexDecision = RouterLogic.routeDecision(
        "Architect a scalable distributed microservice system with event-driven design patterns and race condition handling",
        config
      );
      assert.strictEqual(complexDecision.savings, false, "Complex prompt should NOT yield savings");
    });

    it("should fall back to static routing when useDynamicTiers is false", () => {
      const config: RouterConfig = {
        ...defaultConfig,
        useDynamicTiers: false,
        availableModels: ["openai/gpt-4o-mini", "openai/gpt-4o"]
      };
      const decision = RouterLogic.routeDecision("What is a closure?", config);
      assert.strictEqual(decision.model, "openai/gpt-4o-mini");
    });

    it("should fall back to static routing when availableModels is empty", () => {
      const config: RouterConfig = {
        ...defaultConfig,
        useDynamicTiers: true,
        availableModels: []
      };
      const decision = RouterLogic.routeDecision("What is a closure?", config);
      assert.strictEqual(decision.model, "openai/gpt-4o-mini");
    });

    it("should respect custom threshold values", () => {
      const lowThreshConfig: RouterConfig = {
        ...defaultConfig,
        threshold: 2.0  // Very low threshold — nearly everything goes to strong
      };
      const decision = RouterLogic.routeDecision("Explain what is HTTP", lowThreshConfig);
      assert.strictEqual(decision.model, "openai/gpt-4o",
        "With threshold=2.0, even explanations should go to strong model");
    });

    it("should respect custom model names", () => {
      const config: RouterConfig = {
        cheapModel: "custom/cheap-model",
        strongModel: "custom/strong-model",
        threshold: 6.5,
        lowThreshold: 4.0,
        useDynamicTiers: false
      };
      const decision = RouterLogic.routeDecision("What is X?", config);
      assert.strictEqual(decision.model, "custom/cheap-model");
    });
  });

  // ─── extractCleanPrompt ───────────────────────────────────────────

  describe("extractCleanPrompt", () => {

    it("should return empty string for undefined input", () => {
      assert.strictEqual(RouterLogic.extractCleanPrompt(undefined), "");
    });

    it("should return empty string for empty input", () => {
      assert.strictEqual(RouterLogic.extractCleanPrompt(""), "");
    });

    it("should return empty string for whitespace-only input", () => {
      assert.strictEqual(RouterLogic.extractCleanPrompt("   "), "");
    });

    it("should extract content from <user_request> tags", () => {
      const raw = "<user_request>Write a function to sort an array</user_request>";
      assert.strictEqual(RouterLogic.extractCleanPrompt(raw), "Write a function to sort an array");
    });

    it("should prefer <user_request> content even with surrounding noise", () => {
      const raw = "Some preamble <context>ctx</context> <user_request>The actual request</user_request> trailing";
      assert.strictEqual(RouterLogic.extractCleanPrompt(raw), "The actual request");
    });

    it("should strip <context> tags when no <user_request> is present", () => {
      const raw = "<context>Some context here</context> Please help me fix this bug";
      const cleaned = RouterLogic.extractCleanPrompt(raw);
      assert.ok(!cleaned.includes("<context>"), "Should strip context tags");
      assert.ok(cleaned.includes("fix this bug"), "Should preserve actual content");
    });

    it("should strip <system> tags", () => {
      const raw = "<system>System instructions</system> Write unit tests";
      const cleaned = RouterLogic.extractCleanPrompt(raw);
      assert.ok(!cleaned.includes("<system>"), "Should strip system tags");
      assert.ok(cleaned.includes("Write unit tests"), "Should preserve user content");
    });

    it("should handle nested XML-like tags", () => {
      const raw = "<context><inner>nested</inner></context> Actual prompt";
      const cleaned = RouterLogic.extractCleanPrompt(raw);
      assert.ok(cleaned.includes("Actual prompt"));
    });

    it("should handle plain text without any tags", () => {
      const raw = "Just a plain prompt with no tags";
      assert.strictEqual(RouterLogic.extractCleanPrompt(raw), raw);
    });

    it("should trim whitespace from extracted content", () => {
      const raw = "<user_request>   padded content   </user_request>";
      assert.strictEqual(RouterLogic.extractCleanPrompt(raw), "padded content");
    });
  });
});
