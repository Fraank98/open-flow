import { describe, it, expect } from "vitest";
import {
  WHISPER_MODELS,
  LLM_MODELS,
  TIERS,
  getModelById,
  getTier,
  tierTotals,
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

  it("every whisper and llm model has a non-empty label and description", () => {
    for (const m of [...WHISPER_MODELS, ...LLM_MODELS]) {
      expect(m.label.trim()).not.toBe("");
      expect(m.description.trim()).not.toBe("");
      expect(m.ramBytes).toBeGreaterThan(0);
    }
  });

  it("tierTotals returns the summed download size and the summed RAM of its two models", () => {
    const balanced = tierTotals(getTier("balanced")!);
    expect(balanced).toEqual({ sizeBytes: 487_601_967 + 1_117_320_736, ramBytes: 1_000_000_000 + 1_400_000_000 });
    // Max is ~3.7 GB of download (1.62 + 2.10), not the older ~3.5 GB.
    const max = tierTotals(getTier("max")!);
    expect(max.sizeBytes).toBe(1_624_555_275 + 2_104_932_768);
    expect(max.sizeBytes / 1e9).toBeCloseTo(3.73, 1);
  });

  it("tiers carry an explicit transcriptionNote so Fast and Balanced make clear they share the same Whisper", () => {
    expect(getTier("fast")!.whisperId).toBe(getTier("balanced")!.whisperId);
    expect(getTier("fast")!.transcriptionNote).toBe("Same transcription as Balanced, lighter cleanup.");
    expect(getTier("balanced")!.transcriptionNote).toBe("Recommended for most Macs.");
    expect(getTier("balanced")!.recommended).toBe(true);
    expect(getTier("max")!.transcriptionNote).toBe("Best accuracy. Needs 16 GB of RAM.");
    expect(getTier("max")!.summary).toBe("Whisper Large v3 Turbo + Qwen 3B");
    for (const t of TIERS) expect(t.transcriptionNote.trim()).not.toBe("");
  });

  it("qwen-3b and the max tier carry the non-commercial license note, the other models and tiers carry none", () => {
    const note = "The 3B cleanup model is licensed for non-commercial use only.";
    expect(getModelById("llm", "qwen-3b")!.licenseNote).toBe(note);
    expect(getTier("max")!.licenseNote).toBe(note);
    expect(getTier("fast")!.licenseNote).toBeNull();
    expect(getTier("balanced")!.licenseNote).toBeNull();
    expect(getModelById("llm", "qwen-1.5b")!.licenseNote).toBeNull();
    expect(getModelById("whisper", "whisper-small")!.licenseNote).toBeNull();
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
