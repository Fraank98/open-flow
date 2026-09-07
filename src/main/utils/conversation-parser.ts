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

/** "X ha scritto:" / "X wrote:" with or without the body on the same line.
 *  Accepts long date prefixes ("Il giorno 4 set 2026, alle ore 11:20, …").
 *  Group 1: everything before the verb (the prefix that contains the name).
 *  Group 2: the inline body, possibly empty. */
export const SPEECH_MARKER =
  /^(.{2,140}?)\s+(?:ha scritto|ha detto|wrote|said|says)\s*:\s*(.*)$/iu;

/** Chat attribution "Nome: testo". The name starts with an uppercase letter and
 *  contains only letters, apostrophes, dots, hyphens and spaces (1-28 more
 *  chars): digits are excluded so "Oggi alle 09:12:41" is not a speaker. */
export const ATTRIBUTED = /^(\p{Lu}[\p{L}'.\- ]{1,28}?):\s*(.+)$/u;

/** "Re:", "Fwd:", "Oggetto:", … are the subject, never a speaker. */
export const SUBJECT = /^(?:re|r|fwd|fw|oggetto|subject)\s*:\s*(.+)$/i;

/** Trailing chat timestamp: " 09:12", " 09:12.", " 9.05", " 09:12 PM". */
export const TRAILING_TIME = /\s+\d{1,2}[:.]\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?\.?$/;

/** Fragments that are never content: bare times, counters, glyphs, booleans,
 *  Mail's "message body" placeholder, whitespace. */
export const PURE_NOISE =
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
