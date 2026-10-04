import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WhisperRunner } from "../../src/main/whisper-runner.js";
import { WhisperServer } from "../../src/main/whisper-server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SERVER_BIN = join(ROOT, "resources", "bin", "whisper-server");
const MODEL = join(ROOT, "test", "fixtures", "models", "ggml-tiny.bin");
const TEST_PORT = 18998;

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Generous timeouts on purpose: a cold GitHub macOS runner compiles Metal shaders on
// the first start of llama.cpp v0.4.0 (and whisper.cpp shares the cold-start cost), which can exceed 30s. Production timeouts in src/
// are unchanged on purpose; these are limits of the test, not of the app.
describe("WhisperRunner (integration)", () => {
  let server: WhisperServer;
  let runner: WhisperRunner;

  beforeAll(async () => {
    if (!(await exists(SERVER_BIN))) {
      throw new Error(`Missing whisper-server at ${SERVER_BIN}. Run: npm run fetch-binaries`);
    }
    if (!(await exists(MODEL))) {
      throw new Error(`Missing model at ${MODEL}. Run: npm run fetch-test-models`);
    }
    server = new WhisperServer({
      binaryPath: SERVER_BIN,
      modelPath: MODEL,
      port: TEST_PORT,
      startupTimeoutMs: 120_000,
    });
    await server.start();
    runner = new WhisperRunner({
      endpoint: server.getEndpoint(),
      timeoutMs: 60_000,
    });
  }, 150_000);

  afterAll(() => {
    server?.stop();
  });

  it("transcribes a short English clip", async () => {
    const wav = await readFile(join(ROOT, "test", "fixtures", "audio", "en-short-clean.wav"));
    const result = await runner.transcribe({
      wavBytes: new Uint8Array(wav),
      language: "auto",
    });
    expect(result.text.toLowerCase()).toContain("test");
    expect(result.text.length).toBeGreaterThan(0);
  }, 90_000);

  it("transcribes a short Italian clip", async () => {
    const wav = await readFile(join(ROOT, "test", "fixtures", "audio", "it-short-clean.wav"));
    const result = await runner.transcribe({
      wavBytes: new Uint8Array(wav),
      language: "auto",
    });
    expect(result.text.toLowerCase()).toMatch(/marco|mail|grazie/);
  }, 90_000);

  it("returns empty text for pure silence", async () => {
    const wav = await readFile(join(ROOT, "test", "fixtures", "audio", "silence.wav"));
    const result = await runner.transcribe({
      wavBytes: new Uint8Array(wav),
      language: "auto",
    });
    expect(result.text.length).toBeLessThan(30);
  }, 90_000);
});
