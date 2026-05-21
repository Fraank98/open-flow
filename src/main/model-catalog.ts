import type { ModelDescriptor } from "./utils/model-paths.js";

// Whisper models from ggerganov/whisper.cpp on HuggingFace.
// SHA256 sums sourced from the HuggingFace file metadata as of 2026-05.
// If a checksum mismatch occurs, download is rejected — update here when
// HuggingFace rebuilds the artifact.
export const WHISPER_MODELS: readonly ModelDescriptor[] = [
  {
    id: "whisper-tiny",
    filename: "ggml-tiny.bin",
    sizeBytes: 77_691_713,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  },
  {
    id: "whisper-base",
    filename: "ggml-base.bin",
    sizeBytes: 147_951_465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  },
  {
    id: "whisper-small",
    filename: "ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
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
    description: "Tiny Whisper + 0.5B cleanup. ~470 MB total. Best for slower Macs and quick dictation.",
    whisperId: "whisper-tiny",
    llmId: "qwen-0.5b",
  },
  {
    id: "balanced",
    label: "Balanced (recommended)",
    description: "Base Whisper + 1.5B cleanup. ~1.3 GB total. Good trade-off for Apple Silicon.",
    whisperId: "whisper-base",
    llmId: "qwen-1.5b",
  },
  {
    id: "max",
    label: "Maximum quality",
    description: "Small Whisper + 1.5B cleanup. ~1.6 GB total. Best accuracy at the cost of latency.",
    whisperId: "whisper-small",
    llmId: "qwen-1.5b",
  },
];

export function getModelById(kind: "whisper" | "llm", id: string): ModelDescriptor | undefined {
  const list = kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
  return list.find((m) => m.id === id);
}

export function getTier(id: string): TierDescriptor | undefined {
  return TIERS.find((t) => t.id === id);
}
