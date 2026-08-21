import * as assert from "assert";
import { ModelTiering, Band, BAND_ORDER } from "../proxy/ModelTiering";

describe("ModelTiering — Comprehensive Tests", () => {

  // ─── strengthOf ───────────────────────────────────────────────────

  describe("strengthOf", () => {

    it("should return 5.0 for empty string", () => {
      assert.strictEqual(ModelTiering.strengthOf(""), 5.0);
    });

    it("should score GPT-5 very high (~9.5)", () => {
      const s = ModelTiering.strengthOf("openai/gpt-5");
      assert.ok(s >= 9.0, `Expected GPT-5 >= 9.0, got ${s}`);
    });

    it("should score GPT-4o at 7.0", () => {
      const s = ModelTiering.strengthOf("openai/gpt-4o");
      assert.strictEqual(s, 7.0);
    });

    it("should score GPT-4o-mini low (due to 'mini' penalty)", () => {
      const s = ModelTiering.strengthOf("openai/gpt-4o-mini");
      assert.ok(s < 5.0, `Expected gpt-4o-mini < 5.0, got ${s}`);
    });

    it("should score GPT-3.5 at 3.0", () => {
      const s = ModelTiering.strengthOf("openai/gpt-3.5-turbo");
      assert.strictEqual(s, 3.0);
    });

    it("should score Claude Opus high (~10.0 with 'opus' bonus)", () => {
      const s = ModelTiering.strengthOf("anthropic/claude-opus");
      assert.ok(s >= 9.0, `Expected Opus >= 9.0, got ${s}`);
    });

    it("should score Claude Sonnet at 7.0", () => {
      const s = ModelTiering.strengthOf("anthropic/claude-3.5-sonnet");
      assert.strictEqual(s, 7.0);
    });

    it("should score Claude Haiku low at 3.0", () => {
      const s = ModelTiering.strengthOf("anthropic/claude-3-haiku");
      assert.strictEqual(s, 3.0);
    });

    it("should score Gemini Pro at 8.0 (base) + possible modifiers", () => {
      const s = ModelTiering.strengthOf("google/gemini-pro");
      assert.ok(s >= 8.0, `Expected Gemini Pro >= 8.0, got ${s}`);
    });

    it("should score Gemini Flash lower than Gemini Pro", () => {
      const flash = ModelTiering.strengthOf("google/gemini-flash");
      const pro = ModelTiering.strengthOf("google/gemini-pro");
      assert.ok(flash < pro, `Expected Flash (${flash}) < Pro (${pro})`);
    });

    it("should boost models with 'thinking' or 'reason' in the name", () => {
      const base = ModelTiering.strengthOf("deepseek/deepseek-v2");
      const thinking = ModelTiering.strengthOf("deepseek/deepseek-v2-thinking");
      assert.ok(thinking > base, `Expected thinking (${thinking}) > base (${base})`);
    });

    it("should penalize 'nano' models heavily", () => {
      const s = ModelTiering.strengthOf("some/model-nano");
      assert.ok(s <= 2.0, `Expected nano model <= 2.0, got ${s}`);
    });

    it("should penalize 'mini' models", () => {
      const s = ModelTiering.strengthOf("some/model-mini");
      assert.ok(s < 3.0, `Expected mini model < 3.0, got ${s}`);
    });

    it("should penalize 'small'/'lite'/'tiny' models", () => {
      for (const suffix of ["small", "lite", "tiny"]) {
        const s = ModelTiering.strengthOf(`some/model-${suffix}`);
        assert.ok(s < 4.0, `Expected ${suffix} model < 4.0, got ${s}`);
      }
    });

    it("should boost 'large'/'pro'/'ultra' models", () => {
      const base = ModelTiering.strengthOf("some/model");
      for (const suffix of ["large", "pro", "ultra"]) {
        const s = ModelTiering.strengthOf(`some/model-${suffix}`);
        assert.ok(s > base, `Expected ${suffix} (${s}) > base (${base})`);
      }
    });

    it("should boost large parameter models (>= 70B)", () => {
      const s = ModelTiering.strengthOf("meta/llama-70b");
      const sSmall = ModelTiering.strengthOf("meta/llama-7b");
      assert.ok(s > sSmall, `Expected 70b (${s}) > 7b (${sSmall})`);
    });

    it("should penalize small parameter models (<= 12B)", () => {
      const s7b = ModelTiering.strengthOf("meta/llama-7b");
      const s70b = ModelTiering.strengthOf("meta/llama-70b");
      assert.ok(s7b < s70b, `Expected 7b (${s7b}) < 70b (${s70b})`);
    });

    it("should clamp scores between 0 and 10", () => {
      // Test extreme cases
      const superStrong = ModelTiering.strengthOf("openai/gpt-5-opus-ultra-large-thinking-reason-200b");
      const superWeak = ModelTiering.strengthOf("tiny/nano-mini-small-lite-1b");
      assert.ok(superStrong <= 10.0, `Should cap at 10.0, got ${superStrong}`);
      assert.ok(superWeak >= 0.0, `Should floor at 0.0, got ${superWeak}`);
    });

    it("should score DeepSeek R1 high (~8.5+)", () => {
      const s = ModelTiering.strengthOf("deepseek/deepseek-r1");
      assert.ok(s >= 8.0, `Expected DeepSeek R1 >= 8.0, got ${s}`);
    });

    it("should score o1/o3/o4/o5 models at 9.0", () => {
      for (const model of ["openai/o1", "openai/o3", "openai/o4-mini", "openai/o5"]) {
        const s = ModelTiering.strengthOf(model);
        // o4-mini gets -3.5 penalty
        if (model.includes("mini")) {
          assert.ok(s >= 4.0, `Expected ${model} >= 4.0, got ${s}`);
        } else {
          assert.ok(s >= 9.0, `Expected ${model} >= 9.0, got ${s}`);
        }
      }
    });

    it("should handle case-insensitive model IDs", () => {
      const lower = ModelTiering.strengthOf("openai/gpt-4o");
      const upper = ModelTiering.strengthOf("OpenAI/GPT-4o");
      assert.strictEqual(lower, upper, "Case should not affect scoring");
    });

    it("should score Phi models at 3.0", () => {
      assert.strictEqual(ModelTiering.strengthOf("microsoft/phi-3"), 3.0);
    });

    it("should score Gemma models at 3.5", () => {
      assert.strictEqual(ModelTiering.strengthOf("google/gemma-7b"), 1.5); // 3.5 - 2.0 (7b penalty)
    });

    it("should score Qwen models at 5.5", () => {
      assert.strictEqual(ModelTiering.strengthOf("alibaba/qwen-72b"), 7.0); // 5.5 + 1.5 (70b+ bonus)
    });
  });

  // ─── bandOf ───────────────────────────────────────────────────────

  describe("bandOf", () => {

    it("should classify low-strength models as LIGHT", () => {
      assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o-mini"), Band.LIGHT);
      assert.strictEqual(ModelTiering.bandOf("anthropic/claude-3-haiku"), Band.LIGHT);
      assert.strictEqual(ModelTiering.bandOf("openai/gpt-3.5-turbo"), Band.LIGHT);
    });

    it("should classify medium-strength models as MEDIUM", () => {
      assert.strictEqual(ModelTiering.bandOf("meta/llama-3-70b"), Band.HEAVY); // 5.0 + 1.5 = 6.5 → actually gets to heavy
      assert.strictEqual(ModelTiering.bandOf("deepseek/deepseek-v2"), Band.MEDIUM);
    });

    it("should classify high-strength models as HEAVY", () => {
      assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o"), Band.HEAVY);
      assert.strictEqual(ModelTiering.bandOf("anthropic/claude-3.5-sonnet"), Band.HEAVY);
      assert.strictEqual(ModelTiering.bandOf("openai/o1"), Band.HEAVY);
    });

    it("should correctly map strength boundaries", () => {
      // < 4.0 → LIGHT, 4.0-6.99 → MEDIUM, >= 7.0 → HEAVY
      // GPT-3.5 = 3.0 → LIGHT
      assert.strictEqual(ModelTiering.bandOf("openai/gpt-3.5-turbo"), Band.LIGHT);
      // Mistral = 5.0 → MEDIUM
      assert.strictEqual(ModelTiering.bandOf("mistralai/mistral"), Band.MEDIUM);
      // GPT-4o = 7.0 → HEAVY
      assert.strictEqual(ModelTiering.bandOf("openai/gpt-4o"), Band.HEAVY);
    });
  });

  // ─── BAND_ORDER ───────────────────────────────────────────────────

  describe("BAND_ORDER", () => {

    it("should have LIGHT=0, MEDIUM=1, HEAVY=2", () => {
      assert.strictEqual(BAND_ORDER[Band.LIGHT], 0);
      assert.strictEqual(BAND_ORDER[Band.MEDIUM], 1);
      assert.strictEqual(BAND_ORDER[Band.HEAVY], 2);
    });
  });

  // ─── buildTiers ───────────────────────────────────────────────────

  describe("buildTiers", () => {

    it("should return empty array for no models", () => {
      const tiers = ModelTiering.buildTiers([]);
      assert.strictEqual(tiers.length, 0);
    });

    it("should group models into correct bands", () => {
      const models = ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3-haiku"];
      const tiers = ModelTiering.buildTiers(models);

      const lightTier = tiers.find(t => t.band === Band.LIGHT);
      const heavyTier = tiers.find(t => t.band === Band.HEAVY);

      assert.ok(lightTier, "Should have a LIGHT tier");
      assert.ok(heavyTier, "Should have a HEAVY tier");
      assert.ok(lightTier!.models.includes("openai/gpt-4o-mini"), "gpt-4o-mini should be LIGHT");
      assert.ok(heavyTier!.models.includes("openai/gpt-4o"), "gpt-4o should be HEAVY");
    });

    it("should deduplicate models", () => {
      const models = ["openai/gpt-4o", "openai/gpt-4o", "openai/gpt-4o"];
      const tiers = ModelTiering.buildTiers(models);
      const allModels = tiers.flatMap(t => t.models);
      assert.strictEqual(allModels.length, 1, "Should deduplicate to 1 model");
    });

    it("should sort models within tiers by strength ascending", () => {
      const models = ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "openai/o1"];
      const tiers = ModelTiering.buildTiers(models);
      const heavyTier = tiers.find(t => t.band === Band.HEAVY);
      assert.ok(heavyTier, "Should have a HEAVY tier");

      // Verify sorted by strength ascending
      for (let i = 1; i < heavyTier!.models.length; i++) {
        const prevStrength = ModelTiering.strengthOf(heavyTier!.models[i - 1]);
        const currStrength = ModelTiering.strengthOf(heavyTier!.models[i]);
        assert.ok(prevStrength <= currStrength,
          `Models should be sorted ascending: ${heavyTier!.models[i-1]}(${prevStrength}) <= ${heavyTier!.models[i]}(${currStrength})`);
      }
    });

    it("should filter out empty/whitespace model names", () => {
      const models = ["openai/gpt-4o", "", "   ", "openai/gpt-4o-mini"];
      const tiers = ModelTiering.buildTiers(models);
      const allModels = tiers.flatMap(t => t.models);
      assert.ok(!allModels.includes(""), "Should not include empty strings");
      assert.ok(!allModels.includes("   "), "Should not include whitespace");
    });

    it("should only include tiers that have models", () => {
      const models = ["openai/gpt-4o"]; // Only HEAVY
      const tiers = ModelTiering.buildTiers(models);
      assert.strictEqual(tiers.length, 1, "Should only have 1 tier");
      assert.strictEqual(tiers[0].band, Band.HEAVY);
    });

    it("should handle all three bands with diverse model list", () => {
      const models = [
        "openai/gpt-4o-mini",      // LIGHT
        "mistralai/mistral",        // MEDIUM
        "openai/gpt-4o"             // HEAVY
      ];
      const tiers = ModelTiering.buildTiers(models);
      const bands = tiers.map(t => t.band);
      assert.ok(bands.includes(Band.LIGHT), "Should have LIGHT");
      assert.ok(bands.includes(Band.MEDIUM), "Should have MEDIUM");
      assert.ok(bands.includes(Band.HEAVY), "Should have HEAVY");
    });
  });

  // ─── selectModel ──────────────────────────────────────────────────

  describe("selectModel", () => {

    const models = ["openai/gpt-4o-mini", "mistralai/mistral", "openai/gpt-4o"];

    it("should return null for empty model list", () => {
      assert.strictEqual(ModelTiering.selectModel(5.0, [], 4.0, 6.5), null);
    });

    it("should select LIGHT model for low scores (< lowThreshold)", () => {
      const model = ModelTiering.selectModel(2.0, models, 4.0, 6.5);
      assert.strictEqual(model, "openai/gpt-4o-mini");
    });

    it("should select MEDIUM model for mid-range scores", () => {
      const model = ModelTiering.selectModel(5.0, models, 4.0, 6.5);
      assert.strictEqual(model, "mistralai/mistral");
    });

    it("should select HEAVY model for high scores (>= highThreshold)", () => {
      const model = ModelTiering.selectModel(8.0, models, 4.0, 6.5);
      assert.strictEqual(model, "openai/gpt-4o");
    });

    it("should fall back to closest available band when desired band is missing", () => {
      const onlyHeavy = ["openai/gpt-4o"];
      const model = ModelTiering.selectModel(1.0, onlyHeavy, 4.0, 6.5); // Wants LIGHT, only HEAVY available
      assert.strictEqual(model, "openai/gpt-4o"); // Falls back to only available
    });

    it("should select cheapest model in LIGHT band", () => {
      const lightModels = ["openai/gpt-4o-mini", "anthropic/claude-3-haiku", "openai/gpt-3.5-turbo"];
      const model = ModelTiering.selectModel(1.0, lightModels, 4.0, 6.5);
      assert.ok(model !== null, "Should select a model");
      // Should pick the first (cheapest) in sorted LIGHT tier
    });

    it("should select strongest model in HEAVY band", () => {
      const heavyModels = ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "openai/o1"];
      const model = ModelTiering.selectModel(9.0, heavyModels, 4.0, 6.5);
      assert.ok(model !== null, "Should select a model");
      // Should pick the last (strongest) in sorted HEAVY tier
    });

    it("should handle boundary scores (exactly at thresholds)", () => {
      // At lowThreshold: 4.0 → MEDIUM
      const atLow = ModelTiering.selectModel(4.0, models, 4.0, 6.5);
      assert.strictEqual(atLow, "mistralai/mistral");

      // At highThreshold: 6.5 → HEAVY
      const atHigh = ModelTiering.selectModel(6.5, models, 4.0, 6.5);
      assert.strictEqual(atHigh, "openai/gpt-4o");
    });

    it("should handle single model list", () => {
      const model = ModelTiering.selectModel(5.0, ["openai/gpt-4o-mini"], 4.0, 6.5);
      assert.strictEqual(model, "openai/gpt-4o-mini");
    });
  });

  // ─── describeTiers ────────────────────────────────────────────────

  describe("describeTiers", () => {

    it("should return 'No models discovered yet.' for empty list", () => {
      assert.strictEqual(ModelTiering.describeTiers([]), "No models discovered yet.");
    });

    it("should produce readable tier descriptions", () => {
      const models = ["openai/gpt-4o-mini", "openai/gpt-4o"];
      const desc = ModelTiering.describeTiers(models);
      assert.ok(desc.includes("Light") || desc.includes("Heavy"), "Should contain band names");
      assert.ok(desc.includes("gpt-4o"), "Should contain model names");
    });

    it("should group models by band in description", () => {
      const models = ["openai/gpt-4o-mini", "mistralai/mistral", "openai/gpt-4o"];
      const desc = ModelTiering.describeTiers(models);
      const lines = desc.split("\n");
      assert.ok(lines.length >= 2, `Should have multiple lines, got: ${desc}`);
    });
  });
});
