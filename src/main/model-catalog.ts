import type { ModelDescriptor } from "./utils/model-paths.js";

// Whisper models from ggerganov/whisper.cpp on HuggingFace.
// SHA256 sums sourced from the HuggingFace file metadata as of 2026-05.
// If a checksum mismatch occurs, download is rejected — update here when
// HuggingFace rebuilds the artifact.
export const WHISPER_MODELS: readonly ModelDescriptor[] = [
  {
    id: "whisper-small",
    filename: "ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  },
  {
    id: "whisper-large-v3-turbo",
    filename: "ggml-large-v3-turbo.bin",
    sizeBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
  },
];

// LLM cleanup models — Qwen 2.5 instruct in GGUF Q4_K_M format.
export const LLM_MODELS: readonly ModelDescriptor[] = [
  {
    id: "qwen-0.5b",
    filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sizeBytes: 491_400_032,
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen-1.5b",
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sizeBytes: 1_117_320_736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen-3b",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    sizeBytes: 2_104_932_768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
  },
];

export interface TierDescriptor {
  id: "fast" | "balanced" | "max";
  label: string;
  description: string;
  whisperId: string;
  llmId: string;
}

export const TIERS: readonly TierDescriptor[] = [
  {
    id: "fast",
    label: "Fast",
    description: "Small Whisper + 0.5B cleanup. ~1.0 GB total. Lightest option, good for quick dictation.",
    whisperId: "whisper-small",
    llmId: "qwen-0.5b",
  },
  {
    id: "balanced",
    label: "Balanced (recommended)",
    description: "Small Whisper + 1.5B cleanup. ~1.6 GB total. Good trade-off for Apple Silicon.",
    whisperId: "whisper-small",
    llmId: "qwen-1.5b",
  },
  {
    id: "max",
    label: "Maximum quality",
    description: "Large v3 Turbo + 3B cleanup. ~3.5 GB total. Best accuracy, disfluency-aware.",
    whisperId: "whisper-large-v3-turbo",
    llmId: "qwen-3b",
  },
];

export function getModelById(kind: "whisper" | "llm", id: string): ModelDescriptor | undefined {
  const list = kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
  return list.find((m) => m.id === id);
}

export function getTier(id: string): TierDescriptor | undefined {
  return TIERS.find((t) => t.id === id);
}
