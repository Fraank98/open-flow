import { spawn } from "node:child_process";
import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { sanitizeLlmOutput, SanitizedOutput } from "./utils/output-sanitizer.js";

export interface LLMCleanerOptions {
  binaryPath: string;
  modelPath: string;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  ngl?: number;
}

export interface CleanResult extends SanitizedOutput {
  durationMs: number;
}

export class LLMError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = "LLMError";
  }
}

export class LLMCleaner {
  constructor(private readonly opts: LLMCleanerOptions) {}

  async clean(rawTranscript: string): Promise<CleanResult> {
    const start = Date.now();
    const prompt = buildCleanupPrompt(rawTranscript);
    // Note: this llama-cli build (b0827b2c / "version: 1") defaults to non-conversation
    // mode and does not recognize `-no-cnv`. Conversation must be explicitly enabled
    // via `-cnv`, so we simply omit that flag.
    const args = [
      "-m", this.opts.modelPath,
      "-p", prompt,
      "--no-display-prompt",
      "-n", String(this.opts.maxTokens ?? 512),
      "--temp", String(this.opts.temperature ?? 0.2),
      "-ngl", String(this.opts.ngl ?? 99),
      "--no-warmup",
    ];
    const stdout = await this.spawnAndCollect(args);
    const sanitized = sanitizeLlmOutput(stdout, rawTranscript);
    return { ...sanitized, durationMs: Date.now() - start };
  }

  private spawnAndCollect(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new LLMError("LLM timed out", stderr));
      }, this.opts.timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new LLMError(`LLM spawn failed: ${err.message}`, stderr));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new LLMError(`LLM exited with code ${code}`, stderr));
          return;
        }
        resolve(stdout);
      });
    });
  }
}
