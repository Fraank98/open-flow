/**
 * Deterministic extraction of the two lexical anchors an offer/quote message
 * usually states — the amount and the deadline — copied VERBATIM from the
 * last message, never reformulated and never invented. Exists because the
 * `offer` position set's voice lines were pure abstract instructions with no
 * token from the real message to anchor on, and a small model (Gemma 3 4B)
 * copies the voice's own canned example verbatim when it has nothing else to
 * say (measured live, three separate hotkey presses on a real preventivo:
 * 0, 1 and 0 variants survived the filter, all dropped as instruction-echo).
 * `alternative`'s voice already does this — it interpolates the two real
 * alternatives into the prompt — and that set was measured NOT to collapse
 * on the same conversation. This module is the same fix for `offer`: give
 * its voice a token from the real message that the abstract example cannot
 * possibly contain.
 *
 * Numerals written as words ("tre settimane") are recognized by REUSING
 * number-words.ts's own reader (`parseNumberWords`), not by re-parsing
 * numeral words here: a single-token call tells us whether that token is a
 * genuine numeral, including its exclusion of lone ambiguous words ("un",
 * "una", "sei" as article/verb rather than digit).
 */
import { parseNumberWords } from "./number-words.js";

export interface OfferTerms {
  /** e.g. "4.850 euro", "€500", "1,200 GBP" — sliced verbatim from the message. */
  amount?: string;
  /** e.g. "tre settimane", "3 settimane", "three weeks" — sliced verbatim. */
  deadline?: string;
}

/**
 * A currency symbol directly against a digit run ("€500", "$1,200"), or a
 * digit run followed by a currency word/code ("4.850 euro", "1,200 GBP").
 * The digit run itself (`\d(?:[\d.,]*\d)?`) always starts and ends on a
 * digit, so a thousands/decimal separator is only ever matched between two
 * digits — a sentence-final "." right after the number is never swallowed
 * into it.
 */
const AMOUNT_RE =
  /[€$£]\s?\d(?:[\d.,]*\d)?|\d(?:[\d.,]*\d)?\s?(?:euro|euros|dollari|dollaro|dollars?|sterlin[ae]|pounds?|EUR|USD|GBP)\b/u;

/** Duration nouns a deadline clause is stated in, Italian and English,
 *  singular and plural. Not exhaustive by design — this is a verbatim-copy
 *  anchor, not a general date parser; the abstention path (no terms found)
 *  is the correct outcome for anything outside this list. */
const DURATION_UNITS = new Set([
  "settimana", "settimane", "giorno", "giorni", "mese", "mesi", "anno", "anni", "ora", "ore",
  "week", "weeks", "day", "days", "month", "months", "year", "years", "hour", "hours",
]);

interface Span { text: string; start: number; end: number }

/** Letter/digit runs with their position in the ORIGINAL string, so a match
 *  can be sliced back out of the source text verbatim instead of being
 *  rebuilt from parsed pieces. */
function tokensWithSpans(s: string): Span[] {
  const out: Span[] = [];
  for (const m of s.matchAll(/\p{L}+|\d+/gu)) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** A digit run is always a numeral; a letter run is one only if
 *  number-words.ts's own reader agrees (reused, not reimplemented) — which
 *  already excludes lone ambiguous words like "un"/"una"/"sei". */
function isNumeralToken(text: string): boolean {
  return /^\d+$/u.test(text) || parseNumberWords(text).length > 0;
}

function extractAmount(text: string): string | undefined {
  return AMOUNT_RE.exec(text)?.[0];
}

/** The first "<numeral> <duration unit>" pair, adjacent with nothing but
 *  whitespace between them (the same clause, not two tokens the sentence
 *  happens to carry far apart). */
function extractDeadline(text: string): string | undefined {
  const tokens = tokensWithSpans(text);
  for (let i = 0; i < tokens.length - 1; i++) {
    const cur = tokens[i]!; // i < tokens.length - 1
    const next = tokens[i + 1]!; // i + 1 < tokens.length
    if (!isNumeralToken(cur.text)) continue;
    if (!DURATION_UNITS.has(next.text.toLowerCase())) continue;
    if (!/^\s+$/u.test(text.slice(cur.end, next.start))) continue;
    return text.slice(cur.start, next.end);
  }
  return undefined;
}

/** `undefined` when the message states neither an amount nor a deadline —
 *  an offer without either exists, and abstention (today's behavior) is the
 *  correct outcome for it; this module must never invent an anchor. */
export function extractOfferTerms(lastMessage: string): OfferTerms | undefined {
  const amount = extractAmount(lastMessage);
  const deadline = extractDeadline(lastMessage);
  if (amount === undefined && deadline === undefined) return undefined;
  const terms: OfferTerms = {};
  if (amount !== undefined) terms.amount = amount;
  if (deadline !== undefined) terms.deadline = deadline;
  return terms;
}
