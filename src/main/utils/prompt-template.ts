import { VERBAL_FILLERS, DISCOURSE_FILLERS } from "./filler-words.js";

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

/** Per-language metadata for the rule-B section of the prompt. Each entry
 *  carries the human label, a positive example (filler to remove), and a
 *  negative example (same word used as content — must be left alone). The
 *  word list itself comes from DISCOURSE_FILLERS so prompt and regex never
 *  drift. */
interface LangSection {
  label: string;
  fillerExample: string;
  cleanedExample: string;
  contentExample: string;
  contentReason: string;
}

const LANG_SECTIONS: Record<string, LangSection> = {
  it: {
    label: "Italian",
    fillerExample: '"Allora, pensavo di andare al mare."',
    cleanedExample: '"Pensavo di andare al mare."',
    contentExample: '"Allora ho deciso di partire."',
    contentReason: '"allora" means "then" here',
  },
  en: {
    label: "English",
    fillerExample: '"Well, I was thinking we should leave."',
    cleanedExample: '"I was thinking we should leave."',
    contentExample: '"I know him well."',
    contentReason: '"well" is an adverb here, not a discourse marker',
  },
  de: {
    label: "German",
    fillerExample: '"Also, ich denke wir sollten gehen."',
    cleanedExample: '"Ich denke wir sollten gehen."',
    contentExample: '"Wir gehen also nicht."',
    contentReason: '"also" means "therefore" here',
  },
  fr: {
    label: "French",
    fillerExample: '"Alors, je pense qu\'on devrait partir."',
    cleanedExample: '"Je pense qu\'on devrait partir."',
    contentExample: '"Il est venu, alors j\'ai dit oui."',
    contentReason: '"alors" means "then/so" here',
  },
  es: {
    label: "Spanish",
    fillerExample: '"Bueno, vamos a empezar."',
    cleanedExample: '"Vamos a empezar."',
    contentExample: '"Es un buen libro."',
    contentReason: '"buen/bueno" means "good" here',
  },
};

function renderRuleBSection(lang: string): string {
  const s = LANG_SECTIONS[lang]!;
  const words = DISCOURSE_FILLERS[lang]!.map((w) => `"${w}"`).join(", ");
  return `   ${s.label}: ${words}
   ✓ ${s.fillerExample} → ${s.cleanedExample} (filler)
   ✗ ${s.contentExample} → leave unchanged (${s.contentReason})`;
}

const VERBAL_FILLERS_QUOTED = VERBAL_FILLERS.map((w) => `"${w}"`).join(", ");

const SYSTEM_PREFIX = `Your ONLY job is to remove disfluencies from the transcript. Nothing else.

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

A. Verbal fillers (always remove): ${VERBAL_FILLERS_QUOTED}
   (when standalone, not part of another word).

B. Sentence-initial discourse markers used as filler — remove only when they
   DON'T carry meaning:

`;

const SYSTEM_SUFFIX = `

C. False-start stutters (repetition right after a dash/break):
   "io— io penso che..." → "io penso che..."
   "vol- volevo dire..." → "volevo dire..."
   This is NOT a semantic self-correction; only true repetitions.

When in doubt, leave the word in. Verbatim is always safer than guessing.`;

/**
 * Build the cleanup prompt. Rule B is language-aware:
 *   - If languageHint matches a known language (it/en/de/fr/es), only that
 *     language's discourse-marker list and examples appear — keeps the prompt
 *     compact for monolingual dictation.
 *   - If languageHint is "auto" or unknown, ALL language sections appear and
 *     the model applies whichever fits the input.
 */
export function buildCleanupPrompt(rawTranscript: string, languageHint?: string): string {
  const knownLang =
    languageHint && languageHint !== "auto" && languageHint in LANG_SECTIONS
      ? languageHint
      : null;
  const ruleB = knownLang
    ? renderRuleBSection(knownLang)
    : Object.keys(LANG_SECTIONS).map(renderRuleBSection).join("\n\n");

  let hint = "";
  if (languageHint && languageHint !== "auto") {
    const name = LANGUAGE_NAMES[languageHint] ?? languageHint;
    hint = `\n\nThe input is in ${name}. Your output MUST be in ${name}.`;
  }
  return `${SYSTEM_PREFIX}${ruleB}${SYSTEM_SUFFIX}${hint}

<<<transcript>>>
${rawTranscript}
<<</transcript>>>

Cleaned:`;
}
