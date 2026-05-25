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

// Tight, narrowly-scoped prompt. Small models like Qwen 1.5B treat broad
// instructions like "clean up" as license to rewrite — they paraphrase,
// invent reasoning, change vocabulary. Framing the task as ONLY "insert
// punctuation into the input verbatim" leaves much less room to wander.
const SYSTEM_INSTRUCTIONS = `Your ONLY job is to add punctuation and capitalization to the transcript.

ABSOLUTE RULES — your output is discarded if you break any of these:
1. Use the EXACT words from the input. Do NOT change, replace, reorder,
   paraphrase, or add ANY words. Same vocabulary. Same word order.
2. The ONLY edits allowed are:
   - Add punctuation: . , ? ! ; :
   - Capitalize sentence starts and proper nouns
   - Remove ONLY disfluencies / pure fillers: "uh", "um", "ehm", "hmm",
     "allora", "cioè", "like" (filler), "you know" (filler)
   - Fix missing apostrophes ("l app" → "l'app")
3. Output PLAIN TEXT. No HTML (<b>, <br>, <span>). No Markdown
   (**bold**, *italic*). No XML. No code blocks. No quotes around the text.
4. Output ONLY the transcript. NO commentary, NO preamble like
   "here is" or "cleaned:", NO narration like "delivered by", NO
   meta notes like "(where UI means user interface)".
5. NEVER translate. Output language = input language.

If you don't know what to do, just copy the input verbatim.`;

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
