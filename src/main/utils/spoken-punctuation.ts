/**
 * Convert dictated punctuation names (e.g. "comma", "virgola", "point") into
 * the actual symbols (",", ".", "?", etc.). Runs AFTER Whisper but BEFORE
 * the LLM cleanup so the LLM treats the symbols as normal punctuation
 * instead of as filler words.
 *
 * The substitutions are word-bounded and conservative — they replace the
 * dictated phrase verbatim and leave surrounding context to the LLM (or to
 * downstream code if LLM cleanup is disabled).
 *
 * Examples:
 *   EN: "hello comma world period"            → "hello , world ."
 *   IT: "ciao virgola come stai punto interrogativo" → "ciao , come stai ?"
 *   FR: "bonjour virgule ça va point d'interrogation" → "bonjour , ça va ?"
 *
 * The doubled spaces around the inserted symbols are intentional — they
 * preserve token boundaries; subsequent LLM cleanup (or the trim step at
 * the end of this function) collapses the spaces.
 */

type Rule = { pattern: RegExp; symbol: string };

// Each language's rules. Order matters: multi-word phrases must come before
// single-word phrases that overlap them (e.g. "punto e virgola" before
// "punto" and "virgola").
const RULES_BY_LANG: Record<string, Rule[]> = {
  en: [
    { pattern: /\bopen\s+quote(s)?\b/gi, symbol: '"' },
    { pattern: /\bclose\s+quote(s)?\b/gi, symbol: '"' },
    { pattern: /\bopen\s+(paren|parenthesis|bracket)\b/gi, symbol: "(" },
    { pattern: /\bclose\s+(paren|parenthesis|bracket)\b/gi, symbol: ")" },
    { pattern: /\bnew\s+paragraph\b/gi, symbol: "\n\n" },
    { pattern: /\bnew\s+line\b/gi, symbol: "\n" },
    { pattern: /\bquestion\s+mark\b/gi, symbol: "?" },
    { pattern: /\bexclamation\s+(mark|point)\b/gi, symbol: "!" },
    { pattern: /\bfull\s+stop\b/gi, symbol: "." },
    { pattern: /\bsemi[\s-]?colon\b/gi, symbol: ";" },
    { pattern: /\bcolon\b/gi, symbol: ":" },
    { pattern: /\bcomma\b/gi, symbol: "," },
    { pattern: /\bperiod\b/gi, symbol: "." },
    { pattern: /\bdash\b/gi, symbol: "—" },
    { pattern: /\bhyphen\b/gi, symbol: "-" },
    { pattern: /\bellipsis\b/gi, symbol: "…" },
  ],
  it: [
    { pattern: /\bapri\s+virgolette\b/gi, symbol: '"' },
    { pattern: /\bchiudi\s+virgolette\b/gi, symbol: '"' },
    { pattern: /\bapri\s+parentesi\b/gi, symbol: "(" },
    { pattern: /\bchiudi\s+parentesi\b/gi, symbol: ")" },
    { pattern: /\bnuovo\s+paragrafo\b/gi, symbol: "\n\n" },
    { pattern: /\b(vai\s+)?a\s+capo\b/gi, symbol: "\n" },
    { pattern: /\bpunto\s+e\s+virgola\b/gi, symbol: ";" },
    { pattern: /\bdue\s+punti\b/gi, symbol: ":" },
    { pattern: /\bpunto\s+(interrogativo|di\s+domanda|di\s+interrogazione)\b/gi, symbol: "?" },
    { pattern: /\bpunto\s+esclamativo\b/gi, symbol: "!" },
    { pattern: /\bvirgola\b/gi, symbol: "," },
    { pattern: /\btrattino\b/gi, symbol: "-" },
    { pattern: /\bpuntini\s+di\s+sospensione\b/gi, symbol: "…" },
    { pattern: /\bpunto\b/gi, symbol: "." },
  ],
  es: [
    { pattern: /\babrir?\s+comillas\b/gi, symbol: '"' },
    { pattern: /\bcerrar\s+comillas\b/gi, symbol: '"' },
    { pattern: /\babrir?\s+parentesis\b/gi, symbol: "(" },
    { pattern: /\bcerrar\s+parentesis\b/gi, symbol: ")" },
    { pattern: /\bnuevo\s+parrafo\b/gi, symbol: "\n\n" },
    { pattern: /\bnueva\s+linea\b/gi, symbol: "\n" },
    { pattern: /\bpunto\s+y\s+coma\b/gi, symbol: ";" },
    { pattern: /\bdos\s+puntos\b/gi, symbol: ":" },
    { pattern: /\bsigno\s+de\s+interrogacion\b/gi, symbol: "?" },
    { pattern: /\bsigno\s+de\s+exclamacion\b/gi, symbol: "!" },
    { pattern: /\bcoma\b/gi, symbol: "," },
    { pattern: /\bpunto\b/gi, symbol: "." },
  ],
  fr: [
    { pattern: /\bouvrir\s+guillemets?\b/gi, symbol: '"' },
    { pattern: /\bfermer\s+guillemets?\b/gi, symbol: '"' },
    { pattern: /\bouvrir\s+parenthese\b/gi, symbol: "(" },
    { pattern: /\bfermer\s+parenthese\b/gi, symbol: ")" },
    { pattern: /\bnouveau\s+paragraphe\b/gi, symbol: "\n\n" },
    { pattern: /\bà\s+la\s+ligne\b/gi, symbol: "\n" },
    { pattern: /\bpoint[\s-]virgule\b/gi, symbol: ";" },
    { pattern: /\bdeux\s+points\b/gi, symbol: ":" },
    { pattern: /\bpoint\s+d'interrogation\b/gi, symbol: "?" },
    { pattern: /\bpoint\s+d'exclamation\b/gi, symbol: "!" },
    { pattern: /\bvirgule\b/gi, symbol: "," },
    { pattern: /\btiret\b/gi, symbol: "-" },
    { pattern: /\bpoint\b/gi, symbol: "." },
  ],
  de: [
    { pattern: /\banführungszeichen\s+auf\b/gi, symbol: '"' },
    { pattern: /\banführungszeichen\s+zu\b/gi, symbol: '"' },
    { pattern: /\bklammer\s+auf\b/gi, symbol: "(" },
    { pattern: /\bklammer\s+zu\b/gi, symbol: ")" },
    { pattern: /\bneuer\s+absatz\b/gi, symbol: "\n\n" },
    { pattern: /\bneue\s+zeile\b/gi, symbol: "\n" },
    { pattern: /\bsemikolon\b/gi, symbol: ";" },
    { pattern: /\bdoppelpunkt\b/gi, symbol: ":" },
    { pattern: /\bfragezeichen\b/gi, symbol: "?" },
    { pattern: /\bausrufezeichen\b/gi, symbol: "!" },
    { pattern: /\bkomma\b/gi, symbol: "," },
    { pattern: /\bbindestrich\b/gi, symbol: "-" },
    { pattern: /\bpunkt\b/gi, symbol: "." },
  ],
};

export function applySpokenPunctuation(text: string, languageHint?: string): string {
  const lang = (languageHint ?? "auto").toLowerCase();
  // When the user is on auto-detect we apply EN + IT rules (the two most
  // common for this app's users). Newlines from real dictation make
  // cross-language conflicts rare in practice.
  const ruleSets =
    lang === "auto"
      ? [RULES_BY_LANG.en!, RULES_BY_LANG.it!]
      : RULES_BY_LANG[lang]
        ? [RULES_BY_LANG[lang]!]
        : [];

  let result = text;
  for (const rules of ruleSets) {
    for (const rule of rules) {
      result = result.replace(rule.pattern, ` ${rule.symbol} `);
    }
  }

  // Normalize spacing: collapse multiple spaces, drop spaces around newlines,
  // remove space before a punctuation symbol, collapse blank lines to at
  // most two consecutive newlines (paragraph break).
  result = result
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, (m) => (m.includes("\n\n") || (m.match(/\n/g)?.length ?? 0) >= 2 ? "\n\n" : "\n"))
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .trim();

  return result;
}
