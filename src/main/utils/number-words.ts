/**
 * Numerals written in words (Italian and English) → values. Exists because a
 * benchmarked model wrote "quattro mila ottocento cinquanta euro" and slipped
 * past the digit check of the variant filter (spec §Spike 3).
 *
 * Tokens are lower-cased, accent-stripped letter runs (hyphens split). Each
 * token is segmented greedily, longest vocabulary prefix first; a token is a
 * numeral only if it segments completely ("ottocento" → otto+cento,
 * "ventuno" → vent+uno). Consecutive numeral tokens, optionally joined by
 * "e"/"and", form one number. A run made of a single ambiguous token
 * (un/uno/una/one — articles; sei — "you are") is dropped.
 *
 * Digit runs are tokenized too, but are never numeral tokens themselves
 * (`segment()` rejects them same as any other non-vocabulary word, so they
 * still break a run the way they did when they used to vanish between
 * separators) — they only serve as "a numeral sits right before this point"
 * signal for the percent-idiom guard below. A separator that carries
 * sentence punctuation (`.,;:!?…`) becomes an explicit BARRIER token instead
 * of vanishing silently: this is what stops idiom-stripping from welding the
 * numerals on either side of the idiom together, and what stops a genuine
 * count from being read as part of a thank-you idiom two sentences away
 * (fix round 2, review). Plain separators (spaces, hyphens, apostrophes)
 * still vanish with no token at all, exactly as before.
 */
const IT: Record<string, number> = {
  zero: 0, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10,
  undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18, diciannove: 19,
  venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90,
  vent: 20, trent: 30, quarant: 40, cinquant: 50, sessant: 60, settant: 70, ottant: 80, novant: 90,
  cento: 100, mille: 1000, mila: 1000, milione: 1_000_000, milioni: 1_000_000,
};
const EN: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000,
};
const VOCAB: Record<string, number> = { ...EN, ...IT };
const VOCAB_KEYS_BY_LENGTH = Object.keys(VOCAB).sort((a, b) => b.length - a.length);
const CONNECTORS = new Set(["e", "and"]);
const LONE_AMBIGUOUS = new Set(["un", "uno", "una", "one", "sei"]);

function normalize(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const BARRIER = "\u0000";
const SENTENCE_PUNCT = /[.,;:!?…]/u;

/** Letter runs and digit runs as tokens; a BARRIER token per punctuation
 *  separator; plain separators (space/hyphen/apostrophe/…) produce nothing. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(\p{L}+)|(\p{N}+)|([^\p{L}\p{N}]+)/gu)) {
    if (m[1] !== undefined || m[2] !== undefined) out.push(m[1] ?? m[2]!);
    else if (SENTENCE_PUNCT.test(m[3]!)) out.push(BARRIER);
  }
  return out;
}

/** Greedy longest-prefix segmentation; null when the token is not fully numeral. */
function segment(token: string): number[] | null {
  const out: number[] = [];
  let rest = token;
  while (rest.length > 0) {
    const piece = VOCAB_KEYS_BY_LENGTH.find((k) => rest.startsWith(k));
    if (!piece) return null;
    out.push(VOCAB[piece]!); // piece comes from VOCAB's own keys
    rest = rest.slice(piece.length);
  }
  return out;
}

/** A digit run (never itself parsed as a vocabulary numeral) or a token that
 *  segments completely — i.e. a numeral just emitted, for the "<per> <cento>
 *  is a percent suffix only right after a numeral" guard below. */
function isNumeralToken(token: string | undefined): boolean {
  if (token === undefined) return false;
  return /^\p{N}+$/u.test(token) || segment(token) !== null;
}

function evaluate(pieces: readonly number[]): number {
  let total = 0;
  let group = 0;
  for (const v of pieces) {
    if (v === 100) group = (group === 0 ? 1 : group) * 100;
    else if (v >= 1000) { total += (group === 0 ? 1 : group) * v; group = 0; }
    else group += v;
  }
  return total + group;
}

/**
 * Whether a connector ("e"/"and") between two numeral segments is gluing one
 * compound number (2000 + 300 = "duemila e trecento") rather than naming two
 * separate counts ("due e tre persone" = 2 and 3, not 5). A magnitude marker
 * (>= 100, i.e. cento/mille/mila/…) on either side of the connector is what
 * tells the two apart: plain units summed via "e" are never a single number
 * in speech.
 */
function hasMagnitudeLink(run: readonly number[], nextSeg: readonly number[]): boolean {
  return run.some((v) => v >= 100) || nextSeg.some((v) => v >= 100);
}

/**
 * "cento per cento" ("a hundred percent", idiomatic for "totally") is not
 * two literal hundreds, and "<n> per cento" ("n percent") is one quantity
 * (n) plus a percent suffix, not n and a separate literal 100. Without this,
 * "novanta per cento" parsed as [90, 100], and a 100 nobody said made an
 * otherwise-grounded reply fail the filter's number-anchoring check (found
 * by review, live case: "Il novanta per cento del lavoro è già in review"
 * against a context that only ever said "90%").
 *
 * "<per> <cento>" is only ever a percent suffix right after a numeral
 * (digit or word) already emitted — otherwise "cento" is the genuine count
 * and "per" a plain preposition ("per cento euro" = "for a hundred euros"),
 * and both tokens are left alone (found by review: an unconditional strip
 * let an invented price slip past the filter's number-anchoring check).
 * Removed groups are replaced by a BARRIER, not deleted outright, so they
 * cannot weld the numerals on either side of the idiom into one number
 * (found by review, live case: "novanta per cento, tre giorni" read as 93).
 */
function stripPercentIdioms(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "cento" && tokens[i + 1] === "per" && tokens[i + 2] === "cento") { out.push(BARRIER); i += 3; continue; }
    if (tokens[i] === "per" && tokens[i + 1] === "cento" && isNumeralToken(out[out.length - 1])) { out.push(BARRIER); i += 2; continue; }
    out.push(tokens[i]!); // i < tokens.length (while guard)
    i += 1;
  }
  return out;
}

/**
 * "mille grazie" / "grazie mille" (both orders are idiomatic Italian) and
 * "un milione di grazie" are thank-you idioms, not a count of anything
 * (found by review: parsed as literal 1000/1,000,000 and tripped the
 * filter's number-anchoring check on ordinary gratitude). Removed groups are
 * replaced by a BARRIER, not deleted outright (see stripPercentIdioms):
 * without it, a genuine count followed by an unrelated "grazie" in the next
 * sentence ("Facciamo mille, grazie. Ci penso io...") was eaten too, because
 * nothing marked the sentence break between them (found by review).
 */
function stripGratitudeIdioms(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "mille" && tokens[i + 1] === "grazie") { out.push(BARRIER); i += 2; continue; }
    if (tokens[i] === "grazie" && tokens[i + 1] === "mille") { out.push(BARRIER); i += 2; continue; }
    if ((tokens[i] === "milione" || tokens[i] === "milioni") && tokens[i + 1] === "di" && tokens[i + 2] === "grazie") { out.push(BARRIER); i += 3; continue; }
    out.push(tokens[i]!); // i < tokens.length (while guard)
    i += 1;
  }
  return out;
}

export function parseNumberWords(text: string): number[] {
  const rawTokens = tokenize(normalize(text));
  const tokens = stripGratitudeIdioms(stripPercentIdioms(rawTokens));
  const numbers: number[] = [];
  let run: number[] = [];
  let runTokens: string[] = [];
  const flush = (): void => {
    if (runTokens.length > 0 && !(runTokens.length === 1 && LONE_AMBIGUOUS.has(runTokens[0]!))) numbers.push(evaluate(run)); // length checked
    run = [];
    runTokens = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!; // i < tokens.length
    const seg = segment(t);
    if (seg) { run.push(...seg); runTokens.push(t); continue; }
    const next = tokens[i + 1];
    if (CONNECTORS.has(t) && runTokens.length > 0 && next !== undefined) {
      const nextSeg = segment(next);
      if (nextSeg !== null && hasMagnitudeLink(run, nextSeg)) continue;
    }
    flush();
  }
  flush();
  return numbers;
}
