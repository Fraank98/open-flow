import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WhisperRunner } from "../src/main/whisper-runner.js";
import { LLMCleaner } from "../src/main/llm-cleaner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      wav: { type: "string", short: "w" },
      "whisper-model": { type: "string" },
      "llm-model": { type: "string" },
      language: { type: "string", default: "auto" },
    },
  });

  if (!values.wav) {
    console.error("Usage: npm run smoke -- --wav path/to/audio.wav [--whisper-model ...] [--llm-model ...] [--language auto|en|it]");
    process.exit(1);
  }

  const whisperBin = join(ROOT, "resources", "bin", "whisper-cli");
  const llamaBin = join(ROOT, "resources", "bin", "llama-cli");
  const whisperModel = values["whisper-model"] ??
    join(ROOT, "test", "fixtures", "models", "ggml-tiny.bin");
  const llmModel = values["llm-model"] ??
    join(ROOT, "test", "fixtures", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");

  for (const [label, p] of [
    ["whisper-cli", whisperBin],
    ["llama-cli", llamaBin],
    ["whisper model", whisperModel],
    ["llm model", llmModel],
    ["wav", values.wav],
  ] as const) {
    if (!(await exists(p))) {
      console.error(`Missing ${label}: ${p}`);
      process.exit(1);
    }
  }

  const whisper = new WhisperRunner({
    binaryPath: whisperBin,
    modelPath: whisperModel,
    timeoutMs: 60_000,
  });
  const llm = new LLMCleaner({
    binaryPath: llamaBin,
    modelPath: llmModel,
    timeoutMs: 30_000,
  });

  console.error(`[1/2] Transcribing ${values.wav}...`);
  const t = await whisper.transcribe({ wavPath: values.wav, language: values.language! });
  console.error(`     done in ${t.durationMs}ms, lang=${t.language ?? "?"}`);
  console.error(`     raw: "${t.text}"`);

  console.error(`[2/2] Cleaning...`);
  const c = await llm.clean(t.text);
  console.error(`     done in ${c.durationMs}ms, fallback=${c.usedFallback}`);

  // Final cleaned output to stdout for piping
  process.stdout.write(c.text + "\n");
}

main().catch((err) => {
  console.error("Pipeline error:", err);
  process.exit(1);
});
