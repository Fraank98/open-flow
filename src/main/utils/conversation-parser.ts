/**
 * Deterministic pre-processor for the reply-suggestions feature. No model.
 *
 * Turns the noisy fragments harvested from the Accessibility tree under the
 * mouse into a transcript with explicit roles (`TU (Danilo): …` /
 * `INTERLOCUTORE (Marta): …`), or abstains with a code. It is the first line
 * of privacy: only what survives here ever reaches a model.
 *
 * Phases (spec §3): normalize → keep contentful → dedupe by containment →
 * subject → turns → roles → gates → tail with budget → gist → language.
 *
 * Regexes and thresholds are the ones validated in spike 2 (10/10 on the
 * abstention gates); do not tune them without re-running the corpus test.
 */

/** "X ha scritto:" / "X wrote:" with or without the body on the same line.
 *  Accepts long date prefixes ("Il giorno 4 set 2026, alle ore 11:20, …").
 *  Group 1: everything before the verb (the prefix that contains the name).
 *  Group 2: the inline body, possibly empty. */
export const SPEECH_MARKER =
  /^(.{2,140}?)\s+(?:ha scritto|ha detto|wrote|said|says)\s*:\s*(.*)$/iu;

/** Chat attribution "Nome: testo". The name starts with an uppercase letter and
 *  contains only letters, apostrophes, dots, hyphens and spaces (1-28 more
 *  chars): digits are excluded so "Oggi alle 09:12:41" is not a speaker. */
export const ATTRIBUTED = /^(\p{Lu}[\p{L}'.\- ]{1,28}?):\s*(.+)$/u;

/** "Re:", "Fwd:", "Oggetto:", … are the subject, never a speaker. */
export const SUBJECT = /^(?:re|r|fwd|fw|oggetto|subject)\s*:\s*(.+)$/i;

/** Trailing chat timestamp: " 09:12", " 09:12.", " 9.05", " 09:12 PM". */
export const TRAILING_TIME = /\s+\d{1,2}[:.]\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?\.?$/;

/** Fragments that are never content: bare times, counters, glyphs, booleans,
 *  Mail's "message body" placeholder, whitespace. */
export const PURE_NOISE =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d+|[-–—•⌘⇧↑]|true|false|nan|message body|\p{Z}*)$/iu;

/** An unattributed fragment survives only if it is at least this long: the
 *  length at which it has the shape of a sentence rather than a button label. */
export const SENTENCE_MIN = 60;

const FRAGMENT_SPLIT = /\s*⋄\s*|\r?\n/u;

/** Phase 1. Splits every input on " ⋄ " and newlines, trims, collapses
 *  internal whitespace to one space, drops empties and exact duplicates
 *  (first occurrence wins). Order is preserved: it encodes who spoke first. */
export function normalizeFragments(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    for (const piece of raw.split(FRAGMENT_SPLIT)) {
      const f = piece.replace(/\s+/gu, " ").trim();
      if (f.length === 0 || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** Phase 2. Survival criterion (general, not an app-specific word list): a
 *  fragment stays if it is attributed to someone, marked as speech, a subject
 *  line, or long enough to be a sentence. Everything else is interface. */
export function keepContentful(fragments: readonly string[]): string[] {
  return fragments.filter((f) => {
    if (PURE_NOISE.test(f)) return false;
    if (SUBJECT.test(f)) return true;
    if (SPEECH_MARKER.test(f)) return true;
    if (ATTRIBUTED.test(f)) return true;
    return f.length >= SENTENCE_MIN;
  });
}

function stripTrailingTime(s: string): string {
  return s.replace(TRAILING_TIME, "").trim();
}

/** Phase 3. The AX tree exposes the same text several times (AXValue +
 *  AXDescription, with and without timestamp). Keeps the most informative
 *  version and drops every fragment whose normalized form is contained in a
 *  kept one. Works on indices so the original order is preserved and
 *  identical strings collapse to one (a value-based lookup would keep both). */
export function dedupeByContainment(fragments: readonly string[]): string[] {
  const normalized = fragments.map(stripTrailingTime);
  // Longest first so containers are decided before their contents.
  const byLengthDesc = normalized
    .map((n, i) => i)
    .sort((a, b) => normalized[b]!.length - normalized[a]!.length); // indices come from the same array
  const keptIdx: number[] = [];
  for (const i of byLengthDesc) {
    const n = normalized[i]!; // i is a valid index of `normalized`
    if (n.length < 2) continue;
    if (keptIdx.some((k) => normalized[k]!.includes(n))) continue;
    keptIdx.push(i);
  }
  const keep = new Set(keptIdx);
  return fragments.filter((_, i) => keep.has(i));
}
