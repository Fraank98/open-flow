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

  // Longest first so multi-word / longer terms win over shorter overlapping
  // ones (e.g. "Wispr Flow" over "Flow").
  const ordered = cleaned.sort((a, b) => b.length - a.length);

  // Collect every match across all terms in a single sweep over the ORIGINAL
  // text. Applying terms in separate sequential passes would (a) let a later,
  // shorter term mutate the canonical spelling a longer term just produced, and
  // (b) rely on String.replace's replacement string, which expands $-sequences
  // ($&, $1, …) in a term. Building the output by concatenation avoids both.
  const matches: Array<{ start: number; end: number; term: string }> = [];
  for (const term of ordered) {
    const body = escapeRegExp(term).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    for (const m of text.matchAll(pattern)) {
      matches.push({ start: m.index!, end: m.index! + m[0].length, term });
    }
  }

  // Apply left-to-right; on overlap the longer span wins (ties broken by
  // length). A region already claimed by an earlier replacement is skipped.
  matches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlaps an already-applied replacement
    out += text.slice(cursor, m.start) + m.term;
    cursor = m.end;
  }
  out += text.slice(cursor);
  return out;
}
