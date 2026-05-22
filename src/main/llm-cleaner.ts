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

    // Cap n_predict based on the input length. Small models (Qwen 1.5B) will
    // sometimes "run away" — generate hundreds of tokens of garbage when
    // confused by partial-word Whisper errors — burning ~6s of inference
    // that the sanitizer ultimately rejects. A cleanup pass should never
    // produce dramatically more text than the input (~1.5× as a safety
    // margin for added punctuation and minor expansions).
    const approxInputTokens = Math.ceil(rawTranscript.length / 3); // conservative chars/token estimate
    const dynamicCap = Math.max(48, Math.ceil(approxInputTokens * 1.8));
    const requestedMax = this.opts.maxTokens ?? 512;
    const maxTokens = Math.min(requestedMax, dynamicCap);

    const body = {
      prompt,
      n_predict: maxTokens,
      temperature: this.opts.temperature ?? 0.2,
      // Stop at our transcript delimiter, common EOS markers, and double
      // newline — cleanup output is at most a paragraph.
      stop: ["<<</transcript>>>", "<|im_end|>", "<|endoftext|>", "[end of text]", "\n\n"],
      cache_prompt: true,
      // Small instruct models (Qwen 1.5B) routinely lock into repetition
      // loops on near-identity tasks like transcript cleanup, regenerating
      // the cleaned sentence over and over until n_predict caps them.
      // repeat_penalty + repeat_last_n discourage emitting the same token
      // pattern seen in the recent window.
      repeat_penalty: 1.3,
      repeat_last_n: 128,
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
