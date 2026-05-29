/**
 * Per-language filler lists used by both the LLM prompt template (to show the
 * model what to remove) and the cleaner's fast-path regex (to decide whether
 * to invoke the LLM at all). Sharing the lists keeps prompt and gate aligned —
 * a word the prompt would remove always triggers the gate.
 */

/** Universal verbal fillers — pause sounds that are not real words. The two
 *  language-specific entries (ähm for German, euh for French) are spelled the
 *  way Whisper transcribes them in those languages but are recognized across
 *  the board. */
export const VERBAL_FILLERS = [
  "uh",
  "um",
  "uhh",
  "ehm",
  "uhm",
  "ah",
  "eh",
  "ähm",
  "euh",
] as const;

/** Sentence-initial discourse markers used as filler. The LLM is told to
 *  remove these ONLY when they don't carry meaning — the regex below makes
 *  no such judgment; it just decides whether the LLM should run.
 *
 *  Choices follow what is documented in similar open-source dictation tools
 *  (openwhisper-app, whisper-talk, local-whisper — all English-only) plus the
 *  Italian set we shipped previously, plus reasonable picks for DE/FR/ES.
 *  Excluded "actually"/"literally" (English), "eben"/"nun" (German), "donc"/
 *  "bon" (French), "este"/"entonces" (Spanish) because they are too often
 *  meaningful content words. */
export const DISCOURSE_FILLERS: Record<string, readonly string[]> = {
  it: ["allora", "cioè", "diciamo", "praticamente", "insomma", "tipo", "ecco"],
  en: ["well", "so", "like", "basically", "you know", "I mean"],
  de: ["also", "halt", "naja"],
  fr: ["alors", "bah", "ben", "voilà", "en fait", "tu sais"],
  es: ["pues", "bueno", "o sea", "vale", "digamos"],
};

/** Flat list of every word the regex should detect, across all languages.
 *  The regex doesn't know the input language at runtime, so it checks against
 *  the union. */
export function allFillerWords(): readonly string[] {
  return [...VERBAL_FILLERS, ...Object.values(DISCOURSE_FILLERS).flat()];
}
