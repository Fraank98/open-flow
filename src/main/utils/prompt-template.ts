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

// Short, direct prompt — small instruct models (Qwen 1.5B) follow shorter
// rule lists more reliably than long explanatory text. The CRITICAL RULES
// at the top use ALL-CAPS to draw extra attention.
const SYSTEM_INSTRUCTIONS = `You clean up speech-to-text transcripts.

CRITICAL RULES — break these and your output will be discarded:
1. Output PLAIN TEXT ONLY. No HTML tags (no <b>, <i>, <br>, <span>, etc.).
   No Markdown (**bold**, *italic*, headings). No XML. No code blocks.
2. Output ONLY the cleaned transcript. NO commentary, NO preamble,
   NO "here is", NO "delivered by", NO quotes around the text.
3. NEVER translate. Keep the EXACT language of the input.
4. NEVER add new content, narration, or speaker descriptions.

What to do:
- Remove disfluencies (uh, um, ehm, allora, cioè, like, you know).
- Add ?, !, ., commas where natural.
- Capitalize sentence starts and proper nouns.
- Fix obvious STT mistakes (missing apostrophes: "l app" → "l'app").
- Replace dictated punctuation NAMES with symbols ONLY when clearly a
  command, not a noun. "Hello comma world" → "Hello, world".
  "My period is heavy" stays "My period is heavy".

If the input is very short and already clean, just add appropriate
punctuation and return it.`;

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
