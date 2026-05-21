import { describe, it, expect, beforeAll } from "vitest";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WhisperRunner } from "../../src/main/whisper-runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BIN = join(ROOT, "resources", "bin", "whisper-cli");
const MODEL = join(ROOT, "test", "fixtures", "models", "ggml-tiny.bin");

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("WhisperRunner (integration)", () => {
  beforeAll(async () => {
    if (!(await exists(BIN))) {
      throw new Error(`Missing whisper-cli at ${BIN}. Run: npm run fetch-binaries`);
    }
    if (!(await exists(MODEL))) {
      throw new Error(`Missing model at ${MODEL}. Run: npm run fetch-test-models`);
    }
  });

  it("transcribes a short English clip", async () => {
    const runner = new WhisperRunner({
      binaryPath: BIN,
      modelPath: MODEL,
      timeoutMs: 30_000,
    });
    const result = await runner.transcribe({
      wavPath: join(ROOT, "test", "fixtures", "audio", "en-short-clean.wav"),
      language: "auto",
    });
    expect(result.text.toLowerCase()).toContain("test");
    expect(result.text.length).toBeGreaterThan(0);
  }, 60_000);

  it("transcribes a short Italian clip", async () => {
    const runner = new WhisperRunner({
      binaryPath: BIN,
      modelPath: MODEL,
      timeoutMs: 30_000,
    });
    const result = await runner.transcribe({
      wavPath: join(ROOT, "test", "fixtures", "audio", "it-short-clean.wav"),
      language: "auto",
    });
    // Tiny model is imperfect; accept any non-empty result containing 'marco' or 'mail'
    expect(result.text.toLowerCase()).toMatch(/marco|mail|grazie/);
  }, 60_000);

  it("returns empty text for pure silence", async () => {
    const runner = new WhisperRunner({
      binaryPath: BIN,
      modelPath: MODEL,
      timeoutMs: 30_000,
    });
    const result = await runner.transcribe({
      wavPath: join(ROOT, "test", "fixtures", "audio", "silence.wav"),
      language: "auto",
    });
    // Tiny whisper sometimes hallucinates on silence; accept either empty or trivially short
    expect(result.text.length).toBeLessThan(30);
  }, 60_000);
});
