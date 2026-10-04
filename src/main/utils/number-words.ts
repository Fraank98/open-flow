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
 * sentence punctuation (`.;:!?…`) becomes an explicit hard BARRIER token
 * instead of vanishing silently: this is what stops idiom-stripping from
 * welding the numerals on either side of the idiom together, and what stops
 * a genuine count from being read as part of a thank-you idiom two
 * sentences away (fix round 2, review). A comma gets its own SOFT_BARRIER
 * instead: in English/Italian a comma inside a compound numeral is the
 * normal written form ("one thousand, two hundred", "quattro mila,
 * ottocento cinquanta"), not a sentence break, so — unlike the hard
 * BARRIER — it still glues the numerals on either side together when they
 * are magnitude-linked, exactly like the "e"/"and" connector does (fix
 * round 3, review: a hard barrier on comma silently broke every
 * comma-written compound number and dropped otherwise-grounded replies).
 * Plain separators (spaces, hyphens, apostrophes) still vanish with no
 * token at all, exactly as before.
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
const SOFT_BARRIER = "\u0001";
const SENTENCE_PUNCT = /[.;:!?…]/u;

/** Letter runs and digit runs as tokens; a hard BARRIER token per sentence
 *  punctuation, a SOFT_BARRIER per comma; plain separators
 *  (space/hyphen/apostrophe/…) produce nothing. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(\p{L}+)|(\p{N}+)|([^\p{L}\p{N}]+)/gu)) {
    if (m[1] !== undefined || m[2] !== undefined) { out.push(m[1] ?? m[2]!); continue; }
    const sep = m[3]!;
    if (SENTENCE_PUNCT.test(sep)) out.push(BARRIER);
    else if (sep.includes(",")) out.push(SOFT_BARRIER);
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
 *
 * Must run AFTER stripGratitudeIdioms (see call site in parseNumberWords):
 * the "<per> <cento>" guard anchors on whatever numeral immediately
 * precedes it, and an unremoved "mille" from "grazie mille" is exactly such
 * a numeral — running this first let it wrongly authorize the strip and eat
 * a genuine "cento" ("Grazie mille per cento euro" → [], found by review).
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
  // Gratitude idioms strip first: stripPercentIdioms's "<per> <cento>" guard
  // anchors on the immediately preceding numeral, and running it first meant
  // the still-unremoved "mille" of "grazie mille" was that numeral, wrongly
  // authorizing "per cento" as a percent suffix and eating a genuine "cento"
  // ("Grazie mille per cento euro" → [] instead of [100], found by review).
  const tokens = stripPercentIdioms(stripGratitudeIdioms(rawTokens));
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
    // SOFT_BARRIER (comma) joins two numeral segments exactly like the
    // "e"/"and" connector: only when magnitude-linked, so "due, tre giorni"
    // still reads as two separate counts, not 23 (fix round 3, review).
    if ((CONNECTORS.has(t) || t === SOFT_BARRIER) && runTokens.length > 0 && next !== undefined) {
      const nextSeg = segment(next);
      // For the comma specifically, magnitude-linked is not enough: it is
      // also true when the comma separates two DISTINCT numbers spoken as an
      // enumeration or a negotiated range ("mille, duemila al massimo"), and
      // that must NOT fuse. Inside a genuine compound numeral written with a
      // comma the group after the comma is always strictly smaller than the
      // one before it (1000, 200 — never 1000, 2000); a range/enumeration's
      // second number typically is not smaller. The "e"/"and" connector
      // never needs this extra check — it always glues (fix round 4, review).
      if (nextSeg !== null && hasMagnitudeLink(run, nextSeg) && (t !== SOFT_BARRIER || evaluate(nextSeg) < evaluate(run))) continue;
    }
    flush();
  }
  flush();
  return numbers;
}
