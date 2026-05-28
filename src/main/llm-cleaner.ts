import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { sanitizeLlmOutput, SanitizedOutput } from "./utils/output-sanitizer.js";
import { lightTouchUp } from "./utils/light-touch-up.js";

export interface LLMCleanerOptions {
  /** Base URL of the llama-server, e.g. http://127.0.0.1:18080 */
  endpoint: string;
  timeoutMs: number;
  maxTokens?: number;
  temperature?: number;
  /** Override the HTTP fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface CleanResult extends SanitizedOutput {
  durationMs: number;
  /** True if the LLM was skipped because the transcript had no obvious
   *  disfluency markers. The returned `text` is the raw transcript with
   *  `lightTouchUp` applied. */
  skipped?: boolean;
}

// Markers that justify invoking the LLM. If neither matches, the transcript
// has no disfluencies the model could realistically remove, so we skip the
// round-trip entirely.
const FILLER_TOKENS = /(?<![\p{L}])(ehm|uhm|uhh|uh|um|ah|eh|cioè|allora|diciamo|praticamente|insomma|tipo|ecco)(?![\p{L}])/iu;
const FALSE_START = /\w+— ?\w+|\w+- \w+/;

function needsCleanup(text: string): boolean {
  return FILLER_TOKENS.test(text) || FALSE_START.test(text);
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

    // Fast-path: nothing for the LLM to remove → return raw with lightTouchUp.
    if (!needsCleanup(rawTranscript)) {
      return {
        text: lightTouchUp(rawTranscript),
        usedFallback: false,
        skipped: true,
        durationMs: Date.now() - start,
      };
    }

    const prompt = buildCleanupPrompt(rawTranscript, languageHint);

    // Cap n_predict based on the input length. The disfluency-only task never
    // produces MORE text than the input (it only removes filler words), so we
    // only need a small margin above input length — enough to allow the
    // capitalize-after-filler boundary (rule 4 in the prompt) and any minor
    // re-tokenization. The 48-token floor protects very short inputs where
    // 1.2x would clip below useful generation length. The fast-path
    // (needsCleanup gate) prevents the cleaner from being called when there
    // are no fillers, so when we DO reach this line we genuinely need the
    // model to remove something.
    const approxInputTokens = Math.ceil(rawTranscript.length / 3); // conservative chars/token estimate
    const dynamicCap = Math.max(48, Math.ceil(approxInputTokens * 1.2));
    const requestedMax = this.opts.maxTokens ?? 512;
    const maxTokens = Math.min(requestedMax, dynamicCap);

    const body = {
      prompt,
      n_predict: maxTokens,
      temperature: this.opts.temperature ?? 0.2,
      // Stop at our transcript delimiter, common EOS markers, a bare
      // "<<<" (catches malformed closing tags the model invents like
      // "<<</clean_transcript>>"), and double newline.
      stop: ["<<<", "<|im_end|>", "<|endoftext|>", "[end of text]", "\n\n"],
      cache_prompt: true,
      // Small instruct models (Qwen 1.5B) routinely lock into repetition
      // loops on near-identity tasks like transcript cleanup, regenerating
      // the cleaned sentence over and over until n_predict caps them.
      // repeat_penalty + repeat_last_n discourage emitting the same token
      // pattern seen in the recent window.
      repeat_penalty: 1.3,
      repeat_last_n: 128,
    };

    const fetchFn = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(`${this.opts.endpoint}/completion`, {
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
