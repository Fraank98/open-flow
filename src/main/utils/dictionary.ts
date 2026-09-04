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
  return applyFuzzy(out, ordered);
}

/** Classic iterative Levenshtein edit distance. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/** Fuzzy distance budget for a term: 1 for 6-7 chars, 2 for >=8. The >=8 band
 *  (not >=10) is what lets "gianluk" -> "Gianluca" (8 chars, distance 2) correct
 *  while 6-7 char terms stay at the most conservative distance 1. */
function fuzzyThreshold(termLen: number): number {
  return termLen >= 8 ? 2 : 1;
}

/**
 * Conservative single-token fuzzy repair. Gates (all must hold):
 *   - term length >= 6 (short terms are never fuzzy-matched);
 *   - |sourceToken.length - term.length| <= 2 (length proximity);
 *   - edit distance <= fuzzyThreshold(term.length);
 *   - the token isn't already an exact (case-insensitive) match of any term;
 *   - the match is UNIQUE — if two+ eligible terms qualify, skip the token.
 */
function applyFuzzy(text: string, terms: string[]): string {
  // Single-token fuzzy only: a term with a space can't fuzzy-match one token
  // without expanding it into a multi-word span (out of scope; the exact pass
  // handles multi-word terms).
  const eligible = terms.filter((t) => t.length >= 6 && !t.includes(" "));
  if (eligible.length === 0) return text;
  const exactLower = new Set(terms.map((t) => t.toLowerCase()));

  const tokenRe = /[\p{L}\p{N}][\p{L}\p{N}''-]*/gu;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(tokenRe)) {
    const token = match[0];
    const start = match.index!;
    out += text.slice(last, start);
    last = start + token.length;

    const lower = token.toLowerCase();
    let replacement = token;
    if (!exactLower.has(lower)) {
      const candidates: string[] = [];
      for (const term of eligible) {
        if (Math.abs(token.length - term.length) > 2) continue;
        if (editDistance(lower, term.toLowerCase()) <= fuzzyThreshold(term.length)) {
          candidates.push(term);
        }
      }
      if (candidates.length === 1) replacement = candidates[0]!;
    }
    out += replacement;
  }
  out += text.slice(last);
  return out;
}
