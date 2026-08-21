export enum Band {
  LIGHT = "Light",
  MEDIUM = "Medium",
  HEAVY = "Heavy"
}

export const BAND_ORDER: Record<Band, number> = {
  [Band.LIGHT]: 0,
  [Band.MEDIUM]: 1,
  [Band.HEAVY]: 2
};

export interface Tier {
  band: Band;
  models: string[];
}

export class ModelTiering {
  public static strengthOf(modelId: string): number {
    const id = modelId.toLowerCase().trim();
    if (!id) return 5.0;

    let s = 5.0;

    if (/gpt-?5/.test(id)) s = 9.5;
    else if (/\bo[1345]/.test(id)) s = 9.0;
    else if (id.includes("gpt-4.1")) s = 8.0;
    // NOTE: gpt-4o must be checked before the generic gpt-4 branch, and must
    // rank ABOVE it. v1 gave gpt-4 = 7.5 and gpt-4o = 7.0, inverting the most
    // common model pair in a Copilot subscription.
    else if (id.includes("gpt-4o")) s = 7.5;
    else if (id.includes("gpt-4")) s = 7.0;
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
    // NOTE: the mini penalty must be large enough that a mini variant of a
    // strong base model still lands in the Light band (e.g. gpt-4o 7.5 → 3.5).
    else if (/\bmini\b/.test(id) || id.includes("-mini")) s -= 4.0;
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

  /**
   * Minimum strength a model needs before we trust it to emit well-formed
   * `tool_calls` JSON. Light models frequently produce malformed argument
   * chunks that break the IDE's SSE parser, so agent requests are floored at
   * the Medium band (see RouterLogic).
   */
  public static readonly MIN_TOOL_STRENGTH = 4.0;

  /** True when the model is strong enough to be trusted with tool calling. */
  public static supportsReliableToolCalling(modelId: string): boolean {
    return this.strengthOf(modelId) >= this.MIN_TOOL_STRENGTH;
  }

  /** Returns the strongest model available inside a band, or null. */
  public static strongestInBand(band: Band, models: string[]): string | null {
    const tier = this.buildTiers(models).find((t) => t.band === band);
    if (!tier || tier.models.length === 0) return null;
    return tier.models[tier.models.length - 1];
  }

  /**
   * Picks a model for the requested band.
   *
   * Within Light/Medium we take the *strongest* member of the band (best
   * quality for the price point we already committed to), and if the band is
   * empty we fall back to the nearest populated band — preferring to round
   * UP, because under-powering causes failures while over-powering only costs
   * a little more.
   */
  public static strongestInBandOrClosest(band: Band, models: string[]): string | null {
    const tiers = this.buildTiers(models);
    if (tiers.length === 0) return null;

    const exact = tiers.find((t) => t.band === band);
    if (exact && exact.models.length > 0) {
      return exact.models[exact.models.length - 1];
    }

    const desired = BAND_ORDER[band];
    const sorted = [...tiers].sort((a, b) => {
      const da = BAND_ORDER[a.band] - desired;
      const db = BAND_ORDER[b.band] - desired;
      // Prefer the closest band; on a tie prefer the stronger one.
      const rankA = Math.abs(da) * 2 + (da < 0 ? 1 : 0);
      const rankB = Math.abs(db) * 2 + (db < 0 ? 1 : 0);
      return rankA - rankB;
    });

    const chosen = sorted[0];
    return chosen.models[chosen.models.length - 1];
  }

  public static bandOf(modelId: string): Band {
    const s = this.strengthOf(modelId);
    if (s < 4.0) return Band.LIGHT;
    if (s < 7.0) return Band.MEDIUM;
    return Band.HEAVY;
  }

  public static buildTiers(models: string[]): Tier[] {
    const clean = Array.from(new Set(models.map(m => m.trim()).filter(m => m.length > 0)));
    const bands = [Band.LIGHT, Band.MEDIUM, Band.HEAVY];
    
    return bands
      .map(band => ({
        band,
        models: clean.filter(m => this.bandOf(m) === band).sort((a, b) => this.strengthOf(a) - this.strengthOf(b))
      }))
      .filter(t => t.models.length > 0);
  }

  public static selectModel(
    score: number,
    models: string[],
    lowThreshold: number,
    highThreshold: number
  ): string | null {
    const tiers = this.buildTiers(models);
    if (tiers.length === 0) return null;

    let desired: Band;
    if (score < lowThreshold) desired = Band.LIGHT;
    else if (score < highThreshold) desired = Band.MEDIUM;
    else desired = Band.HEAVY;

    const byBand = new Map<Band, Tier>();
    for (const t of tiers) {
      byBand.set(t.band, t);
    }

    let chosen = byBand.get(desired);
    if (!chosen) {
      const desiredOrder = BAND_ORDER[desired];
      let bestTier = tiers[0];
      let minDiff = Infinity;
      for (const t of tiers) {
        const diff = Math.abs(BAND_ORDER[t.band] - desiredOrder) * 2 + BAND_ORDER[t.band];
        if (diff < minDiff) {
          minDiff = diff;
          bestTier = t;
        }
      }
      chosen = bestTier;
    }

    return chosen.band === Band.HEAVY
      ? chosen.models[chosen.models.length - 1]
      : chosen.models[0];
  }

  public static describeTiers(models: string[]): string {
    const tiers = this.buildTiers(models);
    if (tiers.length === 0) return "No models discovered yet.";
    return tiers.map(t => `${t.band.padEnd(10)} → ${t.models.join(", ")}`).join("\n");
  }
}
