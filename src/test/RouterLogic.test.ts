import * as assert from "assert";
import { RouterLogic } from "../proxy/RouterLogic";
import { ModelTiering } from "../proxy/ModelTiering";

describe("Copilot Pulse VS Code - RouterLogic & ModelTiering", () => {
  it("should score simple lookup prompts low", () => {
    const score = RouterLogic.calculateScore("What is a binary search tree?");
    assert.ok(score < 5.0, `Expected low score for simple lookup, got ${score}`);
  });

  it("should score complex architecture and refactoring prompts high", () => {
    const prompt = "Architect a scalable microservices event-driven system to handle race conditions and deadlock under high concurrency.";
    const score = RouterLogic.calculateScore(prompt);
    assert.ok(score >= 6.5, `Expected high score for architecture, got ${score}`);
  });

  it("should categorize models correctly into bands", () => {
    assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o-mini"), "Light");
    assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o"), "Heavy");
    assert.strictEqual(ModelTiering.bandOf("anthropic/claude-3.5-sonnet"), "Heavy");
  });

  it("should select appropriate model based on prompt complexity score", () => {
    const models = ["openai/gpt-4o-mini", "openai/gpt-4o"];
    const cheapModel = ModelTiering.selectModel(2.0, models, 4.0, 6.5);
    const strongModel = ModelTiering.selectModel(8.0, models, 4.0, 6.5);

    assert.strictEqual(cheapModel, "openai/gpt-4o-mini");
    assert.strictEqual(strongModel, "openai/gpt-4o");
  });
});
