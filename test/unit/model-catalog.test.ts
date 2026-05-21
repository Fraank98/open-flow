import { describe, it, expect } from "vitest";
import {
  WHISPER_MODELS,
  LLM_MODELS,
  TIERS,
  getModelById,
  getTier,
} from "../../src/main/model-catalog.js";

describe("model catalog", () => {
  it("exposes whisper models with required descriptor fields", () => {
    for (const m of WHISPER_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.filename).toMatch(/\.bin$/);
      expect(m.url).toMatch(/^https:\/\/huggingface\.co\//);
      expect(m.sizeBytes).toBeGreaterThan(0);
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("exposes LLM models with .gguf filenames", () => {
    for (const m of LLM_MODELS) {
      expect(m.filename).toMatch(/\.gguf$/);
      expect(m.sizeBytes).toBeGreaterThan(0);
    }
  });

  it("has three tiers: fast, balanced, max", () => {
    const ids = TIERS.map((t) => t.id);
    expect(ids).toEqual(["fast", "balanced", "max"]);
  });

  it("each tier references existing whisper + llm ids", () => {
    const whisperIds = new Set(WHISPER_MODELS.map((m) => m.id));
    const llmIds = new Set(LLM_MODELS.map((m) => m.id));
    for (const tier of TIERS) {
      expect(whisperIds.has(tier.whisperId)).toBe(true);
      expect(llmIds.has(tier.llmId)).toBe(true);
    }
  });

  it("getModelById returns the descriptor by id", () => {
    const first = WHISPER_MODELS[0]!;
    expect(getModelById("whisper", first.id)).toEqual(first);
    expect(getModelById("whisper", "nonexistent")).toBeUndefined();
  });

  it("getTier returns tier descriptor by id", () => {
    expect(getTier("balanced")?.id).toBe("balanced");
    expect(getTier("nope")).toBeUndefined();
  });
});
