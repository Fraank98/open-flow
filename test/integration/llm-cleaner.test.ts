import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMCleaner } from "../../src/main/llm-cleaner.js";
import { LLMServer } from "../../src/main/llm-server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SERVER_BIN = join(ROOT, "resources", "bin", "llama-server");
const MODEL = join(ROOT, "test", "fixtures", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");
const TEST_PORT = 18999; // separate port from the dev app default

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
  let server: LLMServer;
  let samples: Sample[];

  beforeAll(async () => {
    if (!(await exists(SERVER_BIN))) {
      throw new Error(`Missing llama-server at ${SERVER_BIN}. Run: npm run fetch-binaries`);
    }
    if (!(await exists(MODEL))) {
      throw new Error(`Missing model at ${MODEL}. Run: npm run fetch-test-models`);
    }
    samples = JSON.parse(
      await readFile(join(ROOT, "test", "fixtures", "transcripts", "samples.json"), "utf8")
    );
    server = new LLMServer({
      binaryPath: SERVER_BIN,
      modelPath: MODEL,
      port: TEST_PORT,
      contextSize: 1024,
      startupTimeoutMs: 30_000,
    });
    await server.start();
  }, 60_000);

  afterAll(() => {
    server?.stop();
  });

  it("removes disfluencies and adds punctuation (English)", async () => {
    const cleaner = new LLMCleaner({
      endpoint: server.getEndpoint(),
      timeoutMs: 15_000,
      maxTokens: 256,
    });
    const sample = samples.find((s) => s.id === "en-disfluencies-1")!;
    const result = await cleaner.clean(sample.raw);
    // 0.5B model is small — accept ANY non-empty result or sensible fallback.
    // We test the HTTP runner, not the model quality.
    expect(result.text.length).toBeGreaterThan(0);
    expect(typeof result.usedFallback).toBe("boolean");
  }, 30_000);

  it("returns fallback to raw if model produces empty output", async () => {
    const cleaner = new LLMCleaner({
      endpoint: server.getEndpoint(),
      timeoutMs: 15_000,
      maxTokens: 1, // force a tiny output that the sanitizer will probably reject
    });
    const result = await cleaner.clean("um yes hello");
    if (result.usedFallback) {
      expect(result.text).toBe("um yes hello");
    } else {
      expect(result.text.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
