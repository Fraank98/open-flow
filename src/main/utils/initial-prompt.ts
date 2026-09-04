/**
 * Build a Whisper `initial_prompt` from dictionary terms — a comma-separated
 * vocabulary hint that biases the decoder toward the user's preferred spellings.
 *
 * Whisper truncates initial_prompt to ~224 tokens (n_text_ctx/2); we cap by
 * character budget on this side so the cut is explicit and the dropped terms
 * can be logged (they remain covered by the downstream dictionary correction).
 */
export interface BuiltPrompt {
  prompt: string;
  dropped: string[];
}

// ~4 chars/token heuristic against the ~224-token budget, kept conservative.
const DEFAULT_MAX_CHARS = 700;

export function buildInitialPrompt(
  terms: string[],
  opts: { maxChars?: number } = {},
): BuiltPrompt {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return { prompt: "", dropped: [] };

  const kept: string[] = [];
  const dropped: string[] = [];
  let len = 0;
  for (const term of cleaned) {
    const add = (kept.length === 0 ? 0 : 2) + term.length; // ", " separator
    if (len + add <= maxChars) {
      kept.push(term);
      len += add;
    } else {
      dropped.push(term);
    }
  }
  return { prompt: kept.join(", "), dropped };
}
