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

describe("reply model catalog", () => {
  it("lists exactly the two benchmarked Gemma GGUFs, byte-exact", () => {
    expect(REPLY_MODELS.map((m) => [m.id, m.filename, m.sizeBytes, m.sha256])).toEqual([
      ["gemma-3-4b", "gemma-3-4b-it-Q4_K_M.gguf", 2_489_894_016, "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19"],
      ["gemma-4-e4b", "gemma-4-E4B-it-Q4_K_M.gguf", 4_977_171_584, "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87"],
    ]);
    for (const m of REPLY_MODELS) expect(m.url).toBe(`https://huggingface.co/unsloth/${m.id === "gemma-3-4b" ? "gemma-3-4b-it-GGUF" : "gemma-4-E4B-it-GGUF"}/resolve/main/${m.filename}`);
  });

  it("has two tiers, default and max, resolving to existing reply models", () => {
    expect(REPLY_TIERS.map((t) => [t.id, t.replyModelId])).toEqual([["default", "gemma-3-4b"], ["max", "gemma-4-e4b"]]);
    const ids = new Set(REPLY_MODELS.map((m) => m.id));
    for (const t of REPLY_TIERS) expect(ids.has(t.replyModelId)).toBe(true);
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

  it("keeps Qwen out of the reply catalog", () => {
    for (const m of REPLY_MODELS) expect(m.id.startsWith("qwen")).toBe(false);
  });
});
