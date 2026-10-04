import type { ModelDescriptor } from "./utils/model-paths.js";

/** A downloadable model plus the human-facing metadata the UI shows. */
export type CatalogModel = ModelDescriptor & {
  label: string;
  description: string;
  /** Approximate resident memory while the model is loaded. */
  ramBytes: number;
  /** Non-null when the model's license restricts how the app may be used. */
  licenseNote: string | null;
};

const GEMMA_3_LICENSE_NOTE = "Subject to Google's Gemma Terms of Use and Prohibited Use Policy.";
// Gemma 4 is Apache-2.0 (https://ai.google.dev/gemma/docs/gemma_4_license): no note.
const QWEN_3B_LICENSE_NOTE = "The 3B cleanup model is licensed for non-commercial use only.";

// Whisper models from ggerganov/whisper.cpp on HuggingFace.
// SHA256 sums sourced from the HuggingFace file metadata as of 2026-05.
// If a checksum mismatch occurs, download is rejected — update here when
// HuggingFace rebuilds the artifact.
export const WHISPER_MODELS: readonly CatalogModel[] = [
  {
    id: "whisper-small",
    label: "Whisper Small",
    description: "Fast. Good for English and Italian.",
    ramBytes: 1_000_000_000,
    licenseNote: null,
    filename: "ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo",
    description: "Most accurate. Slower on 8 GB Macs.",
    ramBytes: 2_500_000_000,
    licenseNote: null,
    filename: "ggml-large-v3-turbo.bin",
    sizeBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  },
];

// LLM cleanup models — Qwen 2.5 instruct in GGUF Q4_K_M format.
export const LLM_MODELS: readonly CatalogModel[] = [
  {
    id: "qwen-0.5b",
    label: "Qwen 2.5 0.5B",
    description: "Lightest cleanup. May over-edit.",
    ramBytes: 700_000_000,
    licenseNote: null,
    filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sizeBytes: 491_400_032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen-1.5b",
    label: "Qwen 2.5 1.5B",
    description: "Recommended balance of speed and quality.",
    ramBytes: 1_400_000_000,
    licenseNote: null,
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sizeBytes: 1_117_320_736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen-3b",
    label: "Qwen 2.5 3B",
    description: "Best cleanup. Slower on 8 GB Macs.",
    ramBytes: 2_600_000_000,
    licenseNote: QWEN_3B_LICENSE_NOTE,
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    sizeBytes: 2_104_932_768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
  },
];

export interface TierDescriptor {
  id: "fast" | "balanced" | "max";
  label: string;
  /** One-line description: the model pair, e.g. "Whisper Small + Qwen 1.5B". */
  description: string;
  summary: string;
  /** Plain-language note on what this tier does for transcription. */
  transcriptionNote: string;
  recommended: boolean;
  /** Non-null when this tier includes a model with a restrictive license. */
  licenseNote: string | null;
  whisperId: string;
  llmId: string;
}

export const TIERS: readonly TierDescriptor[] = [
  {
    id: "fast",
    label: "Fast",
    description: "Whisper Small + Qwen 0.5B",
    summary: "Whisper Small + Qwen 0.5B",
    transcriptionNote: "Same transcription as Balanced, lighter cleanup.",
    recommended: false,
    licenseNote: null,
    whisperId: "whisper-small",
    llmId: "qwen-0.5b",
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Whisper Small + Qwen 1.5B",
    summary: "Whisper Small + Qwen 1.5B",
    transcriptionNote: "Recommended for most Macs.",
    recommended: true,
    licenseNote: null,
    whisperId: "whisper-small",
    llmId: "qwen-1.5b",
  },
  {
    id: "max",
    label: "Maximum quality",
    description: "Whisper Large v3 Turbo + Qwen 3B",
    summary: "Whisper Large v3 Turbo + Qwen 3B",
    transcriptionNote: "Best accuracy. Comfortable on 16 GB, slower on 8 GB.",
    recommended: false,
    licenseNote: QWEN_3B_LICENSE_NOTE,
    whisperId: "whisper-large-v3-turbo",
    llmId: "qwen-3b",
  },
];

// Reply-suggestion models: the two Gemma GGUFs of the spec's benchmark,
// byte-exact. The "thinking on by default" finding (spec §Spike 3) was made on
// THESE files; a different GGUF of the same family may template differently.
export const REPLY_MODELS: readonly CatalogModel[] = [
  {
    id: "gemma-3-4b",
    label: "Gemma 3 4B",
    description: "Gemma 3 4B. Faster, a good fit for most Macs.",
    ramBytes: 3_100_000_000,
    licenseNote: GEMMA_3_LICENSE_NOTE,
    filename: "gemma-3-4b-it-Q4_K_M.gguf",
    sizeBytes: 2_489_894_016,
    sha256: "04a43a22e8d2003deda5acc262f68ec1005fa76c735a9962a8c77042a74a7d19",
    url: "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
  },
  {
    id: "gemma-4-e4b",
    label: "Gemma 4 E4B",
    description: "Gemma 4 E4B. Slower, best with 24 GB of RAM or more.",
    ramBytes: 5_800_000_000,
    licenseNote: null,
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    sizeBytes: 4_977_171_584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    url: "https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
  },
];

export interface ReplyTierDescriptor {
  id: "default" | "max";
  label: string;
  /** Benchmark prose, shown collapsed under "Benchmark details" (never on the card line). */
  benchmark: string;
  replyModelId: string;
}

// The benchmark text reflects the Task 1 classifier benchmark, not an assumption
// about which model is safer: "default" carries that name only because it is
// DEFAULT_PREFS.replyModelId (spec-mandated pending the deterministic-gate
// measurement), not because it scored better. No logic here depends on the
// array order or on the "default"/"max" ids — getReplyTier looks up by id.
// Inverting which model is the spec's default stays a DATA-only change,
// confined to this file and preferences-store.ts, but it is at least four
// edits across the two files, not one: DEFAULT_PREFS.replyModelId, BOTH
// REPLY_TIERS[].replyModelId (so the UI still shows the right tier as
// default), and swapping the two `benchmark` strings below — they are written
// as per-model facts (percentages, latency) and would describe the wrong model
// if left in place. The one-line card descriptions live on REPLY_MODELS.
export const REPLY_TIERS: readonly ReplyTierDescriptor[] = [
  {
    id: "default",
    label: "Standard",
    benchmark:
      "In the benchmark of the classifier alone, Gemma 3 4B misread 4 of 8 questions that were really asking for something only you know " +
      '(for example "how often do you go to the gym?"). With the deterministic pre-gate that runs before the classifier (active in this build) ' +
      "that drops to 1 of 8. Still check a proposal before you accept it.",
    replyModelId: "gemma-3-4b",
  },
  {
    id: "max",
    label: "Maximum quality",
    benchmark:
      "In the benchmark, Gemma 4 E4B never mistook a question asking for a fact for one that needs a decision (0 false positives out of 8). " +
      "It is slower (about 900 ms) and in 3 cases out of 12 it did not offer a reply that would have been appropriate. Recommended from 24 GB of RAM.",
    replyModelId: "gemma-4-e4b",
  },
];

/** What the Settings window needs to draw one reply-model card. */
export interface ReplyCard {
  /** The model id (cards are keyed by model, like the other kinds). */
  id: string;
  tierId: ReplyTierDescriptor["id"];
  label: string;
  description: string;
  details: string;
  sizeBytes: number;
  ramBytes: number;
  licenseNote: string | null;
}

/** One card per tier: the tier supplies the name and the benchmark prose, the model the one-line description and the sizes. */
export function replyCards(): ReplyCard[] {
  const cards: ReplyCard[] = [];
  for (const tier of REPLY_TIERS) {
    const model = REPLY_MODELS.find((m) => m.id === tier.replyModelId);
    if (!model) continue;
    cards.push({
      id: model.id,
      tierId: tier.id,
      label: tier.label,
      description: model.description,
      details: tier.benchmark,
      sizeBytes: model.sizeBytes,
      ramBytes: model.ramBytes,
      licenseNote: model.licenseNote,
    });
  }
  return cards;
}

export function getModelById(kind: "whisper" | "llm" | "reply", id: string): CatalogModel | undefined {
  const list = kind === "whisper" ? WHISPER_MODELS : kind === "llm" ? LLM_MODELS : REPLY_MODELS;
  return list.find((m) => m.id === id);
}

export function getTier(id: string): TierDescriptor | undefined {
  return TIERS.find((t) => t.id === id);
}

export function getReplyTier(id: string): ReplyTierDescriptor | undefined {
  return REPLY_TIERS.find((t) => t.id === id);
}

/** The tier made of exactly this whisper + llm pair, if any (models picked one by one in Settings may match none). */
export function tierForModels(whisperId: string, llmId: string): TierDescriptor | undefined {
  return TIERS.find((t) => t.whisperId === whisperId && t.llmId === llmId);
}

/**
 * Total download size and RAM of a tier. The two models are loaded together,
 * so RAM is the sum, not the max. UI copy must use this instead of hard-coded
 * sizes.
 */
export function tierTotals(t: TierDescriptor): { sizeBytes: number; ramBytes: number } {
  const whisper = getModelById("whisper", t.whisperId);
  const llm = getModelById("llm", t.llmId);
  if (!whisper || !llm) throw new Error(`Tier ${t.id} references an unknown model`);
  return {
    sizeBytes: whisper.sizeBytes + llm.sizeBytes,
    ramBytes: whisper.ramBytes + llm.ramBytes,
  };
}
