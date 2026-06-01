import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { sanitizeLlmOutput, SanitizedOutput } from "./utils/output-sanitizer.js";
import { lightTouchUp } from "./utils/light-touch-up.js";
import { allFillerWords } from "./utils/filler-words.js";

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
// round-trip entirely. The token list is shared with the prompt template
// (filler-words.ts) so the regex always knows about every word the LLM is
// instructed to remove. We don't know the input language at runtime, so the
// regex unions every language's discourse markers — the prompt's "leave when
// it carries meaning" rule handles legitimate occurrences.
const FILLER_TOKENS = (() => {
  const tokens = allFillerWords()
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) // belt-and-braces escape
    .join("|");
  return new RegExp(`(?<![\\p{L}])(${tokens})(?![\\p{L}])`, "iu");
})();
// Only dash/break-marked stutters trigger the gate ("io— io", "vol- volevo").
// KNOWN LIMITATION: Whisper usually transcribes real stutters as plain adjacent
// repetitions WITHOUT a dash ("io io penso"), which this regex misses — so they
// take the fast-path and never reach the LLM (which, when called, removes them
// well). We deliberately do NOT gate on bare adjacent duplicates: the model
// then collapses legitimate Italian reduplication too ("via via"→"via" is
// wrong, "no no"→"no" debatable), and the subsequence sanitizer can't catch it
// (a dropped duplicate is still a valid subsequence). Net: under-clean real
// stutters rather than risk corrupting meaningful reduplication.
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
      // Cleanup is a near-copy task: the output should reuse ~95% of the input
      // tokens. A high repeat_penalty fights that — it pushes the model to
      // SUBSTITUTE input words to dodge the penalty, mangling conjugations
      // (volevo→voleva, vado→va) and inflating word-drift until the sanitizer
      // rejects the result and falls back to raw. Measured on the fixtures, 1.3
      // fell back on most runs (EN 3/3, IT 2/3); 1.1 eliminated the fallbacks
      // with no mangling. Keep a mild penalty for residual loop protection —
      // the sanitizer's repetition guard is the real backstop against loops.
      repeat_penalty: 1.1,
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
