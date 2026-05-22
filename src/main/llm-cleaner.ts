import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { sanitizeLlmOutput, SanitizedOutput } from "./utils/output-sanitizer.js";

export interface LLMCleanerOptions {
  /** Base URL of the llama-server, e.g. http://127.0.0.1:18080 */
  endpoint: string;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
}

export interface CleanResult extends SanitizedOutput {
  durationMs: number;
}

export class LLMError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = "LLMError";
  }
}

interface LlamaCompletionResponse {
  content?: string;
  stop_type?: string;
}

/**
 * Cleans a raw transcript by posting to a llama-server /completion endpoint.
 * The server holds the model in memory across calls, so per-request latency
 * is ~100-500ms instead of the ~2-5s cold-start of spawning llama-cli.
 */
export class LLMCleaner {
  constructor(private readonly opts: LLMCleanerOptions) {}

  async clean(rawTranscript: string, languageHint?: string): Promise<CleanResult> {
    const start = Date.now();
    const prompt = buildCleanupPrompt(rawTranscript, languageHint);
    const body = {
      prompt,
      n_predict: this.opts.maxTokens ?? 512,
      temperature: this.opts.temperature ?? 0.2,
      // Stop generation at our own transcript delimiter or common EOS markers
      // so the LLM doesn't keep babbling past the cleaned text.
      stop: ["<<</transcript>>>", "<|im_end|>", "<|endoftext|>", "[end of text]"],
      cache_prompt: true,
    };

    let res: Response;
    try {
      res = await fetch(`${this.opts.endpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new LLMError(
        `LLM HTTP request failed`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMError(`LLM HTTP ${res.status}`, text.slice(0, 500));
    }
    const data = (await res.json()) as LlamaCompletionResponse;
    const raw = data.content ?? "";
    const sanitized = sanitizeLlmOutput(raw, rawTranscript);
    return { ...sanitized, durationMs: Date.now() - start };
  }
}
