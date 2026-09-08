import { guessLanguage } from "./conversation-parser.js";
import { parseNumberWords } from "./number-words.js";
import { positionsFor } from "./reply-positions.js";

export type FilterRule =
  | "length" | "done-action" | "invented-reason" | "signature" | "unanchored-number"
  | "question-echo" | "language" | "instruction-echo" | "near-duplicate";

export interface FilterVariant { key: string; label: string; text: string }

export interface FilterInput {
  variants: readonly FilterVariant[];
  lastMessage: string;
  transcript: string;
  counterpart: string;
  userDisplayName: string;
  language: "it" | "en" | "other";
}

export interface FilterOutput {
  kept: FilterVariant[];
  /** For the log only: never the text (spec §6). */
  dropped: Array<{ key: string; rule: FilterRule }>;
}

/** Fewer survivors than this → the coordinator abstains: one proposal is not
 *  a choice and reads as an authoritative suggestion (spec §6). */
export const MIN_KEPT = 2;

// Below this a reply is a degenerate fragment ("Ok."), above it it stops
// being a quick dictated reply and starts being an essay a model padded out.
const LENGTH_MIN = 20;
const LENGTH_MAX = 280;
// Jaccard thresholds measured in the spike: 0.6 catches a variant that just
// restates the question instead of answering it; 0.75 catches near-copies
// among the three variants (a small model rewriting the same idea thrice).
const ECHO_THRESHOLD = 0.6;
const DUPLICATE_THRESHOLD = 0.75;

// Measured in the spike (validate() in strategy.mjs), kept verbatim plus the
// English "I just <verb>ed" form. English past participles are irregular
// often enough in business speech ("sent", "given", "done", …) that a bare
// "\p{L}+ed" suffix misses common cases, so a short list of the ones likely
// in this context is spelled out alongside the regular -ed suffix.
const EN_PAST_IRREGULAR = "sent|given|done|made|taken|paid|said|brought|received";
const DONE_ACTION = new RegExp(
  `\\b(ho (?:appena|gi[aà]) \\p{L}+|ho (?:corretto|inviato|rifatto|risolto|sistemato|completato|girato|accettato)|l'ho (?:gi[aà] )?\\p{L}+at[oa]|i(?:'ve| have) (?:just |already )?(?:\\p{L}+ed|${EN_PAST_IRREGULAR})|i just (?:\\p{L}+ed|${EN_PAST_IRREGULAR}))\\b`,
  "iu",
);
// Stock excuses a model invents about the user's own schedule/workload that
// nobody in the conversation ever mentioned ("Non posso, sono in riunione").
const INVENTED_COMMITMENT = /\b(sono in riunione|ho una riunione|sono in ferie|sono fuori sede|ho un altro impegno|altre attivit[aà] urgenti|i(?:'m| am) in a meeting|i(?:'m| am) on leave|out of office)\b/iu;
// Accent-insensitive: "\b" is ASCII-only in JS even under the "u" flag, so a
// trailing "\b" right after an accented vowel ("perché", "poiché") never
// matches — the match text is accent-stripped first (see hasInventedReason).
const CAUSAL = /\b(perche|in quanto|dato che|poiche|siccome|a causa d[iel]|because|since|as i)\b/iu;
const REASON_KEYS = new Set(["decline", "reject_offer"]);
// A model that runs out of things to say sometimes echoes the second-person
// instruction it was given ("Verifichi e fai sapere…") instead of writing a
// first-person reply.
const INSTRUCTION_ECHO = /^\s*(?:verifichi|puoi|non puoi|fai sapere|scegli|rispondi in senso)\b/iu;
// Literal leak of the prompt's own example marker phrase ("nello spirito
// di…"); isCannedExampleCopy below catches the subtler case where the model
// reproduces the example's CONTENT without naming the marker.
const EXAMPLE_ECHO = /\bnello spirito di\b/iu;
// No "i" flag: \p{Lu} inside a case-insensitive Unicode regex would fold
// case and match lowercase names too, defeating the "capitalized name"
// check. Case-insensitivity for the fixed words is spelled out by hand.
const FORMAL_CLOSING = /(?:[Cc]ordiali|[Dd]istinti)\s+[Ss]aluti,?\s+\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)?\s*[.!]?\s*$/u;
const LABEL_PREFIX = /^(?:risposta|reply|messaggio|message|answer)\s*[:\-–]\s*/iu;

/** Stopwords removed before Jaccard (spec §6: "minuscole, senza stopword"). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "e", "o", "ma",
  "se", "che", "non", "mi", "ti", "ci", "vi", "si", "ne", "al", "del", "dal", "nel", "sul", "alla", "della", "dalla", "nella", "sulla",
  "è", "ho", "hai", "ha", "the", "an", "and", "or", "but", "if", "that", "this", "to", "of", "on", "at", "for", "with", "from", "by",
  "is", "are", "be", "you", "your", "we", "our", "it", "as",
]);

function words(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => !STOPWORDS.has(w)));
}

export function jaccardWords(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  return inter / (wa.size + wb.size - inter);
}

export function cleanVariantText(text: string): string {
  let t = text.replace(/[*_]/gu, "").replace(/\s+/gu, " ").trim();
  t = t.replace(LABEL_PREFIX, "").trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ["«", "»"], ["“", "”"]];
  for (const [open, close] of pairs) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) { t = t.slice(1, -1).trim(); break; }
  }
  return t;
}

function firstToken(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSignature(text: string, counterpart: string, user: string): boolean {
  if (FORMAL_CLOSING.test(text)) return true;
  for (const name of [firstToken(counterpart), firstToken(user)].filter((n) => n.length > 0)) {
    const n = escapeRe(name);
    if (new RegExp(`(?:saluti|grazie|presto|cordiali|distinti)[,\\s]*${n}\\s*[.!]?\\s*$`, "iu").test(text)) return true;
    if (new RegExp(`[.!?,]\\s+${n}\\s*[.!]?\\s*$`, "u").test(text)) return true;
  }
  return false;
}

/** Thousands separators removed on both sides; "4.850" and "4850" agree. */
function digitTokens(s: string): string[] {
  return (s.replace(/(?<=\d)[.,](?=\d{3}\b)/gu, "").match(/\d+/gu) ?? []).filter((d) => Number(d) !== 0);
}

function hasUnanchoredNumber(text: string, transcript: string): boolean {
  const ctxDigits = digitTokens(transcript);
  const ctxWordNumbers = new Set(parseNumberWords(transcript));
  const anchored = (value: string): boolean => ctxDigits.some((c) => c.includes(value)) || ctxWordNumbers.has(Number(value));
  for (const d of digitTokens(text)) if (!anchored(d)) return true;
  for (const n of parseNumberWords(text)) if (!anchored(String(n))) return true;
  return false;
}

function contentWords(s: string): string[] {
  return (s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}{4,}/gu) ?? []);
}

/** A causal clause whose content words are mostly absent from the context is
 *  a reason the model made up (Gemma 3 4B: "ho un carico di lavoro pesante"). */
function hasInventedReason(text: string, transcript: string): boolean {
  const stripped = text.normalize("NFD").replace(/\p{M}/gu, "");
  const m = CAUSAL.exec(stripped);
  if (!m) return false;
  const clause = stripped.slice(m.index + m[0].length).split(/[.!?]/u)[0] ?? "";
  const cw = contentWords(clause);
  if (cw.length === 0) return false;
  const ctx = new Set(contentWords(transcript));
  const grounded = cw.filter((w) => ctx.has(w)).length;
  return grounded / cw.length < 0.5;
}

/** Trailing punctuation and casing removed for exact comparison against a
 *  canned voice example (spec extension below). */
function normalizeForExactCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[«»"“”]/gu, "")
    .replace(/[.!?]+\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Verbatim copies of the canned voice examples baked into reply-positions.ts
 * ("per me va bene, procediamo", …), normalized for case/punctuation. Built
 * from the `generic` and `offer` position sets only — `alternative` gets a
 * lexical anchor from the two interpolated alternatives and was not observed
 * to be at risk (spec/Task 3 §Gemma 3 offer regression, extended to generic
 * on the same structural argument).
 */
const CANNED_EXAMPLES: ReadonlySet<string> = new Set(
  [
    ...positionsFor({ kind: "generic", language: "it" }),
    ...positionsFor({ kind: "offer", language: "it" }),
  ]
    .map((p) => /nello spirito di:\s*«([^»]+)»/iu.exec(p.voice)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(normalizeForExactCompare),
);

/**
 * A model given a poor input ("ok?") has nothing of its own to say and
 * echoes the canned example verbatim instead of engaging with the real
 * message (measured with Gemma 3 on the `offer` set, Task 3; the structural
 * cause — no lexical anchor in the prompt — applies to `generic` just as
 * much, so both are checked here).
 */
function isCannedExampleCopy(text: string): boolean {
  return CANNED_EXAMPLES.has(normalizeForExactCompare(text));
}

function ruleFor(v: FilterVariant, input: FilterInput): FilterRule | null {
  const t = v.text;
  if (t.length < LENGTH_MIN || t.length > LENGTH_MAX) return "length";
  if (DONE_ACTION.test(t)) return "done-action";
  if (INVENTED_COMMITMENT.test(t)) return "invented-reason";
  if (REASON_KEYS.has(v.key) && hasInventedReason(t, input.transcript)) return "invented-reason";
  if (isSignature(t, input.counterpart, input.userDisplayName)) return "signature";
  if (hasUnanchoredNumber(t, input.transcript)) return "unanchored-number";
  if (jaccardWords(t, input.lastMessage) > ECHO_THRESHOLD) return "question-echo";
  if (input.language !== "other") {
    const g = guessLanguage(t);
    if (g !== "other" && g !== input.language) return "language";
  }
  if (INSTRUCTION_ECHO.test(t) || EXAMPLE_ECHO.test(t) || isCannedExampleCopy(t)) return "instruction-echo";
  return null;
}

export function filterVariants(input: FilterInput): FilterOutput {
  const kept: FilterVariant[] = [];
  const dropped: FilterOutput["dropped"] = [];
  for (const raw of input.variants) {
    const v = { ...raw, text: cleanVariantText(raw.text) };
    const rule = ruleFor(v, input);
    if (rule) { dropped.push({ key: v.key, rule }); continue; }
    if (kept.some((k) => jaccardWords(k.text, v.text) > DUPLICATE_THRESHOLD)) { dropped.push({ key: v.key, rule: "near-duplicate" }); continue; }
    kept.push(v);
  }
  return { kept, dropped };
}

/** Counts, keys and rules: never text (spec §Privacy 2). */
export function toLogMeta(out: FilterOutput): { kept: number; dropped: Array<{ key: string; rule: FilterRule }> } {
  return { kept: out.kept.length, dropped: out.dropped.map((d) => ({ key: d.key, rule: d.rule })) };
}
