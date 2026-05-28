const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  it: "Italian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ja: "Japanese",
  zh: "Chinese",
};

const SYSTEM_INSTRUCTIONS = `Your ONLY job is to remove disfluencies from the transcript. Nothing else.

ABSOLUTE RULES — your output is discarded if you break any of these:
1. Keep ALL other words EXACTLY as they are. Same order, same vocabulary,
   same spelling.
2. Do NOT add, replace, reorder, or paraphrase ANY word.
3. Do NOT translate. Output language = input language.
4. Do NOT touch punctuation or capitalization. The transcript is already
   punctuated. ONLY exception: when you remove a sentence-initial filler
   ("Allora, ..."), also drop the comma that followed it and capitalize
   the next word.
5. Output ONLY the cleaned text. NO commentary, NO preamble like "here is",
   NO quotes, NO markdown.

What to remove (only these, only when CLEARLY fillers — not meaningful words):

A. Verbal fillers (always remove): "uh", "um", "uhh", "ehm", "uhm", "ah", "eh"
   (when standalone, not part of another word).

B. Sentence-initial Italian discourse markers used as filler:
   "allora", "cioè", "diciamo", "praticamente", "insomma", "tipo", "ecco"
   — remove only when they DON'T carry meaning.
   ✓ "Allora, pensavo di andare al mare." → "Pensavo di andare al mare." (filler)
   ✗ "Allora ho deciso di partire." → leave unchanged ("allora" means "then" here)

C. False-start stutters (repetition right after a dash/break):
   "io— io penso che..." → "io penso che..."
   "vol- volevo dire..." → "volevo dire..."
   This is NOT a semantic self-correction; only true repetitions.

When in doubt, leave the word in. Verbatim is always safer than guessing.`;

export function buildCleanupPrompt(rawTranscript: string, languageHint?: string): string {
  let hint = "";
  if (languageHint && languageHint !== "auto") {
    const name = LANGUAGE_NAMES[languageHint] ?? languageHint;
    hint = `\n\nThe input is in ${name}. Your output MUST be in ${name}.`;
  }
  return `${SYSTEM_INSTRUCTIONS}${hint}

<<<transcript>>>
${rawTranscript}
<<</transcript>>>

Cleaned:`;
}
