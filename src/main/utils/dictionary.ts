/**
 * Normalize a transcript against a user-defined dictionary of preferred
 * spellings (proper nouns, product names, jargon). Pure text→text, runs after
 * spoken-punctuation and before the LLM cleanup in the pipeline.
 *
 * Two correction modes:
 *   - Exact / multi-word: case-insensitive, Unicode-word-bounded replacement of
 *     a term (which may contain spaces) with its canonical spelling.
 *   - Fuzzy (added in a later task): conservative single-token near-miss repair
 *     gated by term length, source-length proximity, and match uniqueness.
 *
 * Empty / whitespace-only dictionaries are a no-op fast path.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyDictionary(text: string, terms: string[]): string {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return text;

  // Longest first so multi-word / longer terms win over shorter overlaps
  // (e.g. "Wispr Flow" before "Flow").
  const ordered = [...cleaned].sort((a, b) => b.length - a.length);

  let result = text;
  for (const term of ordered) {
    // Build a Unicode-aware, case-insensitive, word-bounded pattern. Internal
    // runs of whitespace in a multi-word term match any whitespace run.
    const body = escapeRegExp(term).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    result = result.replace(pattern, term);
  }
  return result;
}
