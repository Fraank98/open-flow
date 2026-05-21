import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface WhisperRunnerOptions {
  binaryPath: string;
  modelPath: string;
  timeoutMs: number;
  threads?: number;
}

export interface TranscribeArgs {
  wavPath: string;
  language: string; // "auto" or ISO code like "en", "it"
}

export interface TranscribeResult {
  text: string;
  language: string | null;
  durationMs: number;
}

export class WhisperError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "WhisperError";
  }
}

export class WhisperRunner {
  constructor(private readonly opts: WhisperRunnerOptions) {}

  async transcribe(args: TranscribeArgs): Promise<TranscribeResult> {
    const outBase = join(tmpdir(), `open-flow-whisper-${randomUUID()}`);
    const start = Date.now();
    const cliArgs = [
      "-m", this.opts.modelPath,
      "-f", args.wavPath,
      "-l", args.language,
      "-t", String(this.opts.threads ?? 4),
      "--output-json",
      "-of", outBase,
      "--no-prints",
    ];

    try {
      await this.spawnAndWait(cliArgs);
      const jsonRaw = await readFile(`${outBase}.json`, "utf8");
      const parsed = JSON.parse(jsonRaw) as WhisperJsonOutput;
      const text = (parsed.transcription ?? [])
        .map((seg) => seg.text ?? "")
        .join("")
        .trim();
      return {
        text,
        language: parsed.result?.language ?? null,
        durationMs: Date.now() - start,
      };
    } finally {
      // Best-effort cleanup
      await unlink(`${outBase}.json`).catch(() => undefined);
    }
  }

  private spawnAndWait(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new WhisperError("Whisper timed out", stderr));
      }, this.opts.timeoutMs);

      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new WhisperError(`Whisper spawn failed: ${err.message}`, stderr));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new WhisperError(`Whisper exited with code ${code}`, stderr));
          return;
        }
        resolve();
      });
    });
  }
}

interface WhisperJsonOutput {
  result?: { language?: string };
  transcription?: Array<{ text?: string }>;
}
