/**
 * Deterministic pre-processor for the reply-suggestions feature. No model.
 *
 * Turns the noisy fragments harvested from the Accessibility tree under the
 * mouse into a transcript with explicit roles (`TU (Danilo): …` /
 * `INTERLOCUTORE (Marta): …`), or abstains with a code. It is the first line
 * of privacy: only what survives here ever reaches a model.
 *
 * Phases (spec §3): normalize → keep contentful → dedupe by containment →
 * subject → turns → roles → gates → tail with budget → gist → language.
 *
 * Regexes and thresholds are the ones validated in spike 2 (10/10 on the
 * abstention gates); do not tune them without re-running the corpus test.
 */

import { hasExplicitProposal } from "./reply-proposal.js";

/** "X ha scritto:" / "X wrote:" with or without the body on the same line.
 *  Accepts long date prefixes ("Il giorno 4 set 2026, alle ore 11:20, …").
 *  Group 1: everything before the verb (the prefix that contains the name).
 *  Group 2: the inline body, possibly empty. */
const SPEECH_MARKER =
  /^(.{2,140}?)\s+(?:ha scritto|ha detto|wrote|said|says)\s*:\s*(.*)$/iu;

/** Chat attribution "Nome: testo". The name starts with an uppercase letter and
 *  contains only letters, apostrophes, dots, hyphens and spaces (1-28 more
 *  chars): digits are excluded so "Oggi alle 09:12:41" is not a speaker. */
export const ATTRIBUTED = /^(\p{Lu}[\p{L}'.\- ]{1,28}?):\s*(.+)$/u;

/** "Re:", "Fwd:", "Oggetto:", … are the subject, never a speaker. */
export const SUBJECT = /^(?:re|r|fwd|fw|oggetto|subject)\s*:\s*(.+)$/i;

/** Trailing chat timestamp: " 09:12", " 09:12.", " 9.05", " 09:12 PM". */
const TRAILING_TIME = /\s+\d{1,2}[:.]\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?\.?$/;

/** Fragments that are never content: bare times, counters, glyphs, booleans,
 *  Mail's "message body" placeholder, whitespace. */
const PURE_NOISE =
  /^(?:\d{1,2}:\d{2}(?::\d{2})?|\d+|[-–—•⌘⇧↑]|true|false|nan|message body|\p{Z}*)$/iu;

/** An unattributed fragment survives only if it is at least this long: the
 *  length at which it has the shape of a sentence rather than a button label. */
export const SENTENCE_MIN = 60;

const FRAGMENT_SPLIT = /\s*⋄\s*|\r?\n/u;

/** Phase 1. Splits every input on " ⋄ " and newlines, trims, collapses
 *  internal whitespace to one space, drops empties and exact duplicates
 *  (first occurrence wins). Order is preserved: it encodes who spoke first. */
export function normalizeFragments(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    for (const piece of raw.split(FRAGMENT_SPLIT)) {
      const f = piece.replace(/\s+/gu, " ").trim();
      if (f.length === 0 || seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

/** Phase 2. Survival criterion (general, not an app-specific word list): a
 *  fragment stays if it is attributed to someone, marked as speech, a subject
 *  line, or long enough to be a sentence. Everything else is interface. */
export function keepContentful(fragments: readonly string[]): string[] {
  return fragments.filter((f) => {
    if (PURE_NOISE.test(f)) return false;
    if (SUBJECT.test(f)) return true;
    if (SPEECH_MARKER.test(f)) return true;
    if (ATTRIBUTED.test(f)) return true;
    return f.length >= SENTENCE_MIN;
  });
}

function stripTrailingTime(s: string): string {
  return s.replace(TRAILING_TIME, "").trim();
}

/** Phase 3. The AX tree exposes the same text several times (AXValue +
 *  AXDescription, with and without timestamp). Keeps the most informative
 *  version and drops every fragment whose normalized form is contained in a
 *  kept one. Works on indices so the original order is preserved and
 *  identical strings collapse to one (a value-based lookup would keep both). */
export function dedupeByContainment(fragments: readonly string[]): string[] {
  const normalized = fragments.map(stripTrailingTime);
  // Longest first so containers are decided before their contents.
  const byLengthDesc = normalized
    .map((n, i) => i)
    .sort((a, b) => normalized[b]!.length - normalized[a]!.length); // indices come from the same array
  const keptIdx: number[] = [];
  for (const i of byLengthDesc) {
    const n = normalized[i]!; // i is a valid index of `normalized`
    if (n.length < 2) continue;
    if (keptIdx.some((k) => normalized[k]!.includes(n))) continue; // k comes from keptIdx, only ever filled with valid indices
    keptIdx.push(i);
  }
  const keep = new Set(keptIdx);
  return fragments.filter((_, i) => keep.has(i));
}

/** A turn before role assignment. */
export interface RawTurn {
  speaker: string;
  text: string;
}

/** A turn with its role, as the spec's `Turn`. */
export interface Turn {
  speaker: string;
  role: "user" | "counterpart";
  text: string;
}

export interface TurnsResult {
  turns: RawTurn[];
  /** From the first Re:/Fwd:/Fw:/Oggetto:/Subject: line, if any. */
  subject: string | undefined;
  /** Sentence-length fragments that preceded any turn: counted for the log,
   *  never kept (nothing to attach them to). */
  unattributedDropped: number;
}

const SPEAKER_MAX = 40;

/** From "Il giorno 4 set 2026, alle ore 11:20, Francesca Bianchi <x@y>" to
 *  "Francesca Bianchi". Strips angle-bracketed addresses, the Italian/English
 *  date prefixes (with or without the time clause), trailing punctuation. */
export function speakerFromPrefix(prefix: string): string {
  const who = prefix
    .replace(/<[^>]*>/g, "")
    .replace(/^(?:il giorno|on)\b.*?(?:,\s*(?:alle ore|at)\s*\d{1,2}:\d{2}\s*)?,\s*/i, "")
    .replace(/^(?:il giorno|on)\s+\S+\s+\S+\s+\d{4},?\s*/i, "")
    .replace(/[,;]\s*$/, "")
    .trim()
    .slice(0, SPEAKER_MAX);
  return who.length > 0 ? who : "Sconosciuto";
}

/** Phases 4-5. Rebuilds the message sequence from the two attribution forms
 *  ("Nome: testo HH:MM." and "X ha scritto:" + body) and pulls the subject
 *  out. An unattributed sentence-length fragment is appended to the previous
 *  turn (spec §3, phase 5); before any turn it is dropped and counted. */
export function toTurns(fragments: readonly string[]): TurnsResult {
  const turns: RawTurn[] = [];
  let subject: string | undefined;
  let pending: string | null = null;
  let unattributedDropped = 0;

  for (const f of fragments) {
    const su = SUBJECT.exec(f);
    if (su) {
      if (subject === undefined) subject = su[1]!.trim(); // group 1 is mandatory in SUBJECT
      continue;
    }
    const sm = SPEECH_MARKER.exec(f);
    if (sm) {
      const who = speakerFromPrefix(sm[1]!); // groups 1 and 2 always exist in SPEECH_MARKER
      const inline = sm[2]!.trim();
      if (inline.length >= 2) {
        turns.push({ speaker: who, text: inline });
        pending = null;
      } else {
        pending = who;
      }
      continue;
    }
    const am = ATTRIBUTED.exec(f);
    if (am) {
      turns.push({ speaker: am[1]!.trim(), text: stripTrailingTime(am[2]!) }); // both groups mandatory
      pending = null;
      continue;
    }
    if (pending !== null) {
      turns.push({ speaker: pending, text: stripTrailingTime(f) });
      pending = null;
      continue;
    }
    if (f.length >= SENTENCE_MIN) {
      const last = turns[turns.length - 1];
      if (last) last.text = `${last.text} ${f}`;
      else unattributedDropped += 1;
    }
  }
  return { turns, subject, unattributedDropped };
}

/** Case-, accent- and whitespace-insensitive form of a name. */
function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Phase 6 criterion. True when the speaker, normalized, equals the
 *  preference, equals its first token (name without surname), or extends it
 *  by whole tokens in either direction ("Danilo Franco" vs "Danilo"). An
 *  empty preference matches nobody: without a name, role inversion is
 *  inevitable, so the feature must not run (spec §Preferenze). */
export function isUserSpeaker(speaker: string, userDisplayName: string): boolean {
  const u = normalizeName(userDisplayName);
  const s = normalizeName(speaker);
  if (u.length === 0 || s.length === 0) return false;
  const first = u.split(" ")[0]!; // split() always yields at least one element
  return s === u || s === first || s.startsWith(`${u} `) || u.startsWith(`${s} `);
}

/** Phase 6. */
export function assignRoles(turns: readonly RawTurn[], userDisplayName: string): Turn[] {
  return turns.map((t) => ({
    speaker: t.speaker,
    role: isUserSpeaker(t.speaker, userDisplayName) ? "user" : "counterpart",
    text: t.text,
  }));
}

export type AbstainReason =
  | "no-attributed-turns"
  | "only-user-turns"
  | "last-turn-is-user"
  | "last-message-too-short"
  | "more-than-two-speakers"
  | "assistant-speaker";

export type GateResult = { ok: true } | { ok: false; reason: AbstainReason };

/** Speakers that are conversational assistants: out of scope by design
 *  (spec §Out). Compared against the normalized speaker name. */
export const ASSISTANT_NAMES: readonly string[] =
  ["chatgpt", "claude", "gemini", "copilot", "assistant", "assistente"];

const RECENT_TURNS_FOR_SPEAKER_COUNT = 8;
/** Floor below which a last message abstains UNLESS it contains an explicit
 *  proposal (hasExplicitProposal, imported below): length alone is not the
 *  criterion, only a proxy for it, and the proxy is wrong for chat — a
 *  message that asks for a decision is often short precisely because it is
 *  direct ("la fai tu?", "confermi?"). Below this, a message is judged on
 *  its content instead of its size (see ABSOLUTE_MIN_CHARS_WITH_PROPOSAL for
 *  the floor that still applies even then). */
const LAST_MESSAGE_MIN_CHARS = 15;
/** Even a message that matches hasExplicitProposal must clear this to reach
 *  the model: below it there is no conversation left to reason about, only
 *  punctuation ("ok?", 3 chars). Set to 4, the length of "puoi" — the
 *  shortest single word hasExplicitProposal's own keyword list can match on
 *  its own (no "?" required); anything shorter than that can never be the
 *  match that rescued the message, so it is not treated as a real proposal. */
const ABSOLUTE_MIN_CHARS_WITH_PROPOSAL = 4;
const MIN_TAIL_BUDGET = 100;
const GIST_MAX_CHARS = 70;

/** Phase 7. All gates are blocking and run in this exact order (spec §3.7).
 *  Abstaining is the normal outcome, not an error. */
export function gate(turns: readonly Turn[]): GateResult {
  const last = turns[turns.length - 1];
  if (!last) return { ok: false, reason: "no-attributed-turns" };
  if (ASSISTANT_NAMES.includes(normalizeName(last.speaker))) return { ok: false, reason: "assistant-speaker" };
  const recent = turns.slice(-RECENT_TURNS_FOR_SPEAKER_COUNT);
  // The user may appear under several spellings ("Danilo", "Danilo Franco"):
  // count them as one via the role, not the name.
  const distinct = new Set(recent.map((t) => (t.role === "user" ? " user" : normalizeName(t.speaker))));
  if (distinct.size > 2) return { ok: false, reason: "more-than-two-speakers" };
  if (turns.every((t) => t.role === "user")) return { ok: false, reason: "only-user-turns" };
  if (last.role === "user") return { ok: false, reason: "last-turn-is-user" };
  // A message under the floor still passes if it contains an explicit
  // proposal (same predicate as the coordinator's own pre-gate, imported
  // from utils/reply-proposal.ts) and clears the absolute floor: shortness
  // alone must not decide this — the content does.
  const lastLen = last.text.trim().length;
  if (lastLen < LAST_MESSAGE_MIN_CHARS) {
    const rescuedByProposal = lastLen >= ABSOLUTE_MIN_CHARS_WITH_PROPOSAL && hasExplicitProposal(last.text);
    if (!rescuedByProposal) return { ok: false, reason: "last-message-too-short" };
  }
  return { ok: true };
}

function roleLabel(t: Turn): string {
  return t.role === "user" ? `TU (${t.speaker}): ` : `INTERLOCUTORE (${t.speaker}): `;
}

/** Phase 8. Tail with a character budget: turns are taken newest-first while
 *  the whole transcript stays <= tailBudgetChars. The last turn is always
 *  present; if it alone exceeds the budget it is cut at the HEAD (the
 *  question is at the end). The subject line, when present, is counted. */
export function buildTranscript(
  turns: readonly Turn[],
  opts: { tailBudgetChars: number; subject?: string },
): string {
  if (opts.tailBudgetChars < MIN_TAIL_BUDGET) {
    throw new RangeError(`tailBudgetChars must be >= ${MIN_TAIL_BUDGET}, got ${opts.tailBudgetChars}`);
  }
  const last = turns[turns.length - 1];
  if (!last) return "";
  const label = roleLabel(last);

  // The subject comes from SUBJECT (`(.+)$`, uncapped) and can be arbitrarily
  // long, so it must be truncated too, not just appended whole. It is capped
  // to leave room for at least the floor of lastLine (label + "…" + one
  // char, the same floor lastLine's own truncation below falls back to) plus
  // the newline that separates head from the body: this guarantees the
  // OGGETTO line alone can never push the transcript past tailBudgetChars
  // (spec, privacy §3.8 — the budget is an invariant, not a best effort).
  const HEAD_PREFIX = "OGGETTO: ";
  const minLastLineFloor = label.length + 2;
  const head = opts.subject === undefined
    ? null
    : (() => {
        const maxHeadLen = Math.max(HEAD_PREFIX.length, opts.tailBudgetChars - 1 - minLastLineFloor);
        const raw = HEAD_PREFIX + opts.subject;
        if (raw.length <= maxHeadLen) return raw;
        const keep = Math.max(HEAD_PREFIX.length, maxHeadLen - 1); // 1 for the ellipsis
        return `${raw.slice(0, keep).trimEnd()}…`;
      })();
  const remaining = opts.tailBudgetChars - (head ? head.length + 1 : 0);

  let lastLine = label + last.text;
  if (lastLine.length > remaining) {
    const keep = Math.max(1, remaining - label.length - 1); // 1 for the ellipsis
    lastLine = `${label}…${last.text.slice(last.text.length - keep)}`;
  }

  const lines: string[] = [lastLine];
  let total = lastLine.length;
  for (let i = turns.length - 2; i >= 0; i--) {
    const t = turns[i]!; // i in [0, length-2]
    const line = roleLabel(t) + t.text;
    if (total + 1 + line.length > remaining) break;
    lines.unshift(line);
    total += 1 + line.length;
  }
  return (head ? `${head}\n` : "") + lines.join("\n");
}

/** Phase 9. "Rispondi a {counterpart}: {frase}" — the first sentence of the
 *  last message that ends with "?", else its first sentence, cut to 70 chars
 *  with "…". Deterministic on purpose: the user sees exactly what the code
 *  took as the question and can reject at a glance. */
export function buildGist(counterpart: string, lastMessage: string): string {
  const sentences = lastMessage.trim().split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter((s) => s.length > 0);
  const question = sentences.find((s) => s.endsWith("?"));
  const chosen = question ?? sentences[0] ?? "";
  const frase = chosen.length > GIST_MAX_CHARS ? `${chosen.slice(0, GIST_MAX_CHARS - 1).trimEnd()}…` : chosen;
  return `Rispondi a ${counterpart}: ${frase}`;
}

// Function words chosen to have no homograph in the other language ("a",
// "in", "due", "come", "i" are excluded for that reason).
const IT_WORDS: ReadonlySet<string> = new Set(["il", "la", "di", "che", "e", "non", "per", "un", "una",
  "con", "sono", "ho", "hai", "è", "ma", "se", "ci", "anche", "del", "della", "le", "gli", "mi", "ti", "lo", "so"]);
const EN_WORDS: ReadonlySet<string> = new Set(["the", "and", "to", "of", "is", "you", "that", "we", "for",
  "it", "with", "on", "are", "this", "have", "can", "be", "at", "not", "from", "or", "will", "your", "when", "could"]);

/** Phase 10. Coarse it/en/other guess on function-word counts. Only the
 *  downstream variant filter uses it (Plan B); "other" is the safe default. */
export function guessLanguage(text: string): "it" | "en" | "other" {
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let it = 0;
  let en = 0;
  for (const t of tokens) {
    if (IT_WORDS.has(t)) it += 1;
    if (EN_WORDS.has(t)) en += 1;
  }
  if (it >= 2 && it > en) return "it";
  if (en >= 2 && en > it) return "en";
  return "other";
}

export interface ParseInput {
  fragments: readonly string[];
  /** Preference, mandatory: empty means every turn is a counterpart's. */
  userDisplayName: string;
  /** 2_500 in production (spec §3.8). */
  tailBudgetChars: number;
}

/** Counts only — safe to log. */
export interface ParseStats {
  fragmentsIn: number;
  fragmentsKept: number;
  fragmentsDeduped: number;
  turns: number;
  speakers: number;
  unattributedDropped: number;
  transcriptChars: number;
}

export type ParseResult =
  | { kind: "abstain"; reason: AbstainReason; stats: ParseStats }
  | {
      kind: "conversation";
      subject?: string;
      turns: Turn[];
      counterpart: string;
      transcript: string;
      lastMessage: string;
      gist: string;
      languageGuess: "it" | "en" | "other";
      stats: ParseStats;
    };

/** The whole pipeline. Pure: same input, same output; no I/O, no logging. */
export function parse(input: ParseInput): ParseResult {
  const normalized = normalizeFragments(input.fragments);
  const kept = keepContentful(normalized);
  const deduped = dedupeByContainment(kept);
  const { turns: raw, subject, unattributedDropped } = toTurns(deduped);
  const turns = assignRoles(raw, input.userDisplayName);
  const stats: ParseStats = {
    fragmentsIn: normalized.length,
    fragmentsKept: kept.length,
    fragmentsDeduped: deduped.length,
    turns: turns.length,
    speakers: new Set(turns.map((t) => normalizeName(t.speaker))).size,
    unattributedDropped,
    transcriptChars: 0,
  };
  const g = gate(turns);
  if (!g.ok) return { kind: "abstain", reason: g.reason, stats };
  const last = turns[turns.length - 1]!; // gate guarantees at least one turn
  const transcript = buildTranscript(turns, { tailBudgetChars: input.tailBudgetChars, subject });
  const result: ParseResult = {
    kind: "conversation",
    turns,
    counterpart: last.speaker,
    transcript,
    lastMessage: last.text,
    gist: buildGist(last.speaker, last.text),
    languageGuess: guessLanguage(turns.map((t) => t.text).join(" ")),
    stats: { ...stats, transcriptChars: transcript.length },
  };
  if (subject !== undefined) result.subject = subject;
  return result;
}

/** What may reach the logger: codes and counts, never text (spec, privacy 2). */
export function toLogMeta(result: ParseResult): Record<string, string | number | null> {
  return {
    kind: result.kind,
    reason: result.kind === "abstain" ? result.reason : null,
    languageGuess: result.kind === "conversation" ? result.languageGuess : null,
    ...result.stats,
  };
}
