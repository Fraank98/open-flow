import { describe, it, expect } from "vitest";
import {
  WHISPER_MODELS,
  LLM_MODELS,
  TIERS,
  REPLY_MODELS,
  REPLY_TIERS,
  getModelById,
  getTier,
  getReplyTier,
  replyCards,
  tierTotals,
  tierForModels,
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
    expect(getTier("max")!.transcriptionNote).toBe("Best accuracy. Comfortable on 16 GB, slower on 8 GB.");
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

describe("reply model catalog", () => {
  it("lists exactly the two benchmarked Gemma GGUFs, byte-exact", () => {
    expect(REPLY_MODELS.map((m) => [m.id, m.filename, m.sizeBytes, m.sha256])).toEqual([
      ["gemma-3-4b", "gemma-3-4b-it-Q4_K_M.gguf", 2_489_894_016, "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19"],
      ["gemma-4-e4b", "gemma-4-E4B-it-Q4_K_M.gguf", 4_977_171_584, "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87"],
    ]);
    for (const m of REPLY_MODELS) expect(m.url).toBe(`https://huggingface.co/unsloth/${m.id === "gemma-3-4b" ? "gemma-3-4b-it-GGUF" : "gemma-4-E4B-it-GGUF"}/resolve/main/${m.filename}`);
  });

  it("only Gemma 3 carries a license note (Gemma Terms of Use); Gemma 4 is Apache-2.0 and carries none", () => {
    expect(getModelById("reply", "gemma-3-4b")!.licenseNote).toBe("Subject to Google's Gemma Terms of Use and Prohibited Use Policy.");
    expect(getModelById("reply", "gemma-4-e4b")!.licenseNote).toBeNull();
  });

  it("has two tiers, default and max, resolving to existing reply models", () => {
    expect(REPLY_TIERS.map((t) => [t.id, t.replyModelId])).toEqual([["default", "gemma-3-4b"], ["max", "gemma-4-e4b"]]);
    const ids = new Set(REPLY_MODELS.map((m) => m.id));
    for (const t of REPLY_TIERS) expect(ids.has(t.replyModelId)).toBe(true);
  });

  it("every reply model has a label, a description and a RAM estimate like the other kinds", () => {
    for (const m of REPLY_MODELS) {
      expect(m.label.trim()).not.toBe("");
      expect(m.description.trim()).not.toBe("");
      expect(m.ramBytes).toBeGreaterThan(m.sizeBytes);
    }
  });

  it("has no duplicated model id across whisper, llm and reply lists", () => {
    const all = [...WHISPER_MODELS, ...LLM_MODELS, ...REPLY_MODELS].map((m) => m.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("getModelById supports kind reply; getReplyTier resolves by id", () => {
    expect(getModelById("reply", "gemma-4-e4b")?.sizeBytes).toBe(4_977_171_584);
    expect(getModelById("reply", "qwen-3b")).toBeUndefined();
    expect(getModelById("llm", "gemma-3-4b")).toBeUndefined();
    expect(getReplyTier("max")?.replyModelId).toBe("gemma-4-e4b");
    expect(getReplyTier("fast")).toBeUndefined();
  });

  it("replyCards: one card per tier, keyed by model id, one-line description, benchmark kept apart", () => {
    const cards = replyCards();
    expect(cards.map((c) => [c.id, c.tierId, c.label])).toEqual([
      ["gemma-3-4b", "default", "Standard"],
      ["gemma-4-e4b", "max", "Maximum quality"],
    ]);
    for (const c of cards) {
      expect(c.description).not.toMatch(/\n/);
      expect(c.description.length).toBeLessThanOrEqual(80);
      // The benchmark prose is for the collapsible details, never the card line.
      expect(c.details.length).toBeGreaterThan(c.description.length);
      expect(c.details).toMatch(/benchmark/i);
      expect(c.sizeBytes).toBe(getModelById("reply", c.id)!.sizeBytes);
      expect(c.ramBytes).toBe(getModelById("reply", c.id)!.ramBytes);
    }
  });

  it("keeps Qwen out of the reply catalog", () => {
    for (const m of REPLY_MODELS) expect(m.id.startsWith("qwen")).toBe(false);
  });
});

describe("tierForModels", () => {
  it("finds the tier whose whisper + llm pair matches", () => {
    for (const t of TIERS) expect(tierForModels(t.whisperId, t.llmId)?.id).toBe(t.id);
  });

  it("is undefined for a pair no tier offers", () => {
    expect(tierForModels("whisper-small", "nope")).toBeUndefined();
  });
});
