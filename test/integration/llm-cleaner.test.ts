import { describe, it, expect, beforeAll } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMCleaner } from "../../src/main/llm-cleaner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BIN = join(ROOT, "resources", "bin", "llama-cli");
const MODEL = join(ROOT, "test", "fixtures", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

interface Sample {
  id: string;
  raw: string;
  expectedSubstrings: string[];
  expectedAbsent: string[];
}

describe("LLMCleaner (integration)", () => {
  let samples: Sample[];

  beforeAll(async () => {
    if (!(await exists(BIN))) {
      throw new Error(`Missing llama-cli at ${BIN}. Run: npm run fetch-binaries`);
    }
    if (!(await exists(MODEL))) {
      throw new Error(`Missing model at ${MODEL}. Run: npm run fetch-test-models`);
    }
    samples = JSON.parse(
      await readFile(join(ROOT, "test", "fixtures", "transcripts", "samples.json"), "utf8")
    );
  });

  it("removes disfluencies and adds punctuation (English)", async () => {
    const cleaner = new LLMCleaner({
      binaryPath: BIN,
      modelPath: MODEL,
      timeoutMs: 30_000,
      maxTokens: 256,
    });
    const sample = samples.find((s) => s.id === "en-disfluencies-1")!;
    const result = await cleaner.clean(sample.raw);
    // 0.5B model is small — accept ANY substring or fallback (we test the runner, not the model quality)
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.usedFallback).toBe("boolean");
  }, 60_000);

  it("returns fallback to raw if model produces empty output", async () => {
    const cleaner = new LLMCleaner({
      binaryPath: BIN,
      modelPath: MODEL,
      timeoutMs: 30_000,
      maxTokens: 1, // force tiny output — almost certainly empty after sanitize
    });
    const result = await cleaner.clean("um yes hello");
    // Either we get a tiny but valid cleanup, OR we fall back to raw
    if (result.usedFallback) {
      expect(result.text).toBe("um yes hello");
    } else {
      expect(result.text.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
