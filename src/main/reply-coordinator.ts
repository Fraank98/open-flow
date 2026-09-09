import { positionsFor } from "./utils/reply-positions.js";
import { MIN_KEPT, hasUnanchoredNumber, toLogMeta as filterLogMeta, type FilterInput, type FilterOutput, type FilterVariant } from "./utils/variant-filter.js";
import { toLogMeta as parserLogMeta, type ParseInput, type ParseResult } from "./utils/conversation-parser.js";
import { toLogMeta as readerLogMeta, type BundleIdFilter, type ReadBudgets, type ReadContextResult } from "./ax-context-reader.js";
import type { ClassifyInput, ClassifyResult } from "./reply-classifier.js";
import type { GenerateInput, GenerateResult } from "./reply-generator.js";
import type { ReplyServerState, SuggestionPayload, SuggestionVariant } from "../shared/reply-types.js";
import type { Logger } from "./logger.js";

/** Budget handed to the parser (spec §3.8 / Global Constraint 15). */
export const TAIL_BUDGET_CHARS = 2_500;
/** Hotkey → pill. Beyond this the user has already started typing by hand. */
export const TOTAL_TIMEOUT_MS = 12_000;
/** The proposals are tied to a moment; after this the user has moved on. */
export const SUGGEST_TTL_MS = 20_000;
export const FLASH_NOTHING_MS = 1_000;
export const FLASH_INFO_MS = 1_500;
export const ERROR_PILL_MS = 2_000;
export const ACTIVATE_TIMEOUT_MS = 300;
export const ACTIVATE_POLL_MS = 50;
export const HIDE_DELAY_MS = 500;
const MAX_VARIANTS = 3;

/** Registered on entering `suggesting`, unregistered on every exit. Command+N
 *  and not a bare 1/2/3: the pill is showInactive() so it receives no key
 *  events, the choice must be a global shortcut, and a global shortcut on a
 *  bare digit would eat the user's typing for the whole life of the pill. */
export const VARIANT_ACCELERATORS = ["Command+1", "Command+2", "Command+3"] as const;
export const ESCAPE_ACCELERATOR = "Escape";

/** Neutral, fixed strings. A flash NEVER carries the reason for an
 *  abstention: the reason would describe what was on screen (spec §Errori). */
export const FLASH_TEXT = {
  appNotAllowed: "App non abilitata — aggiungila nelle preferenze",
  modelLoading: "Modello in caricamento…",
  modelFailed: "Modello non disponibile",
  noUserName: "Imposta il tuo nome nelle preferenze",
  copyOnly: "Copiato — incolla con ⌘V",
} as const;

export type ReplyCoordinatorState = "idle" | "reading" | "thinking" | "suggesting" | "injecting";
export type DismissReason = "esc" | "click" | "hotkey-toggle" | "timeout-ttl" | "ptt-arm" | "quit";

export interface ReplyReaderLike {
  isTrusted(): boolean;
  frontmostPid(): number;
  activateApp(pid: number): boolean;
  read(filter: BundleIdFilter, overrides?: Partial<ReadBudgets>): ReadContextResult;
}
export interface ReplyOverlayLike {
  show(): void;
  hide(): void;
  sendState(state: string): void;
  sendFlash(text: string): void;
  showSuggestions(payload: SuggestionPayload): void;
  resetSize(): void;
}
export interface ReplyShortcutsLike {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
}
export interface ReplyServerStatusLike {
  isReady(): boolean;
  getState(): ReplyServerState;
  recover(): Promise<boolean>;
}
/** The five preferences the flow needs, read fresh at every hotkey so a change
 *  in the preferences window takes effect without a restart. */
export interface ReplyPrefsSnapshot {
  enabled: boolean;
  userDisplayName: string;
  appsMode: "allowlist" | "blocklist";
  apps: string[];
}

export interface ReplyCoordinatorDeps {
  reader: ReplyReaderLike;
  parse: (input: ParseInput) => ParseResult;
  classify: (input: ClassifyInput) => Promise<ClassifyResult>;
  generate: (input: GenerateInput) => Promise<GenerateResult>;
  filterVariants: (input: FilterInput) => FilterOutput;
  overlay: ReplyOverlayLike;
  shortcuts: ReplyShortcutsLike;
  server: ReplyServerStatusLike;
  /** TextInjector.inject: clipboard → ⌘V → restore (existing, untouched). */
  inject: (text: string) => Promise<{ pasted: boolean; reason?: string }>;
  /** Degradation L3: the text stays in the clipboard on purpose. */
  copyToClipboard: (text: string) => void;
  loadPrefs: () => Promise<ReplyPrefsSnapshot>;
  /** True while the dictation pipeline is not idle (mutual exclusion). */
  dictationBusy: () => boolean;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** L5: same dialog the PTT shows. */
  onTrustRequired?: () => void;
  /** Deterministic scope pre-gate, wired ONLY if the Task 1 experiment came
   *  out MITIGAZIONE. Absent means "the classifier is the only scope gate". */
  preGate?: (lastMessage: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Returns its own canceller, so tests need no fake timers. */
  setTimer?: (cb: () => void, ms: number) => () => void;
}

interface Pending {
  payload: SuggestionPayload;
  texts: string[];
  pid: number;
  editableIsFocused: boolean;
  accelerators: string[];
  cancelTtl: () => void;
}

async function raced<T>(work: Promise<T>, deadline: Promise<void>): Promise<{ ok: true; value: T } | { ok: false }> {
  return Promise.race([
    work.then((value) => ({ ok: true as const, value })),
    deadline.then(() => ({ ok: false as const })),
  ]);
}

/** A code, never the exception's own message: a native (N-API) throw can
 *  carry arbitrary text — a path, an address, anything the addon happened to
 *  be holding — and this feature's logs carry metrics and codes only. */
function errorCode(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Deterministic pre-gate over the last message: does it contain an explicit
 * proposal (a modal, two explicit alternatives, an offer)? Regular
 * expressions cannot tell "ti va bene giovedì?" from "a che ora arrivi
 * giovedì?" in general — that is what the classifier is for. Wired only if
 * the Task 1 experiment measured too many false positives on the
 * "information only the user has" cases.
 *
 * Lives in utils/reply-proposal.ts (a pure module, no orchestrator
 * dependency) because the parser's own `gate` needs the same predicate for
 * its `last-message-too-short` check — a short final message should abstain
 * only when it ALSO carries no explicit proposal. Re-exported here so every
 * existing caller (index.ts, tests) keeps importing it from this file.
 */
export { hasExplicitProposal } from "./utils/reply-proposal.js";

function normalizeToken(w: string): string {
  return w.replace(/[‘’ʼ]/gu, "'").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function groundingWords(s: string): Set<string> {
  return new Set(normalizeToken(s).match(/\p{L}+/gu) ?? []);
}

/**
 * `groundingWords`'s `\p{L}+` never matches a digit, so a wrong NUMBER
 * inside an otherwise-overlapping alternative was invisible to the 0.5
 * threshold below (round 2, found by review, executed: "con lo sconto del
 * 20%" scored 1.00 against a message that said 10%, because every non-digit
 * word matched and the digit itself was simply never compared). Exact
 * membership, not a threshold — reuses variant-filter.ts's own
 * digit/percent/word-numeral value comparison (hasUnanchoredNumber) rather
 * than a second copy of it: a number is anchored only if it equals one
 * lastMessage actually states.
 */
function numbersGrounded(alt: string, lastMessage: string): boolean {
  return !hasUnanchoredNumber(alt, lastMessage);
}

/**
 * Same problem, different invisible class: a capitalized token votes as an
 * ordinary word in the 0.5 threshold below, so swapping one name for
 * another barely moves the score (round 2, found by review, executed: "la
 * giro a Marco" scored 0.67 against a message that said Paolo, and the
 * label/prompt/accepted-text chain all carried "Marco" through to the
 * pasted text). Exact membership on the capitalized-token subset only,
 * compared case/accent-insensitively (the SAME normalization
 * `groundingWords` uses) rather than a literal string match: a model that
 * merely re-cases a genuinely-shared word ("Giovedì" for a message's
 * "giovedì") must not be treated as inventing a new name, only one that
 * introduces a capitalized token absent from the message at all. The first
 * token is skipped even when capitalized: these alternatives are short
 * fragments, and sentence-initial capitalization says nothing about whether
 * the word is a name.
 */
function properNounsGrounded(alt: string, lastMessage: string): boolean {
  const names = [...alt.matchAll(/\p{Lu}\p{L}+/gu)].filter((m) => m.index !== 0).map((m) => normalizeToken(m[0]));
  if (names.length === 0) return true;
  const ctxWords = groundingWords(lastMessage);
  return names.every((n) => ctxWords.has(n));
}

/**
 * Is this "alternative" string (free text the MODEL wrote, never checked
 * against the transcript by the classifier's own grammar) actually something
 * the counterpart wrote, or did the model invent it (Important 4)? Both
 * alternatives are interpolated verbatim into the pill's "Scelgo: …" labels
 * and the generator's prompt, so an invented one lets the user choose and
 * commit accepted text to an option nobody ever offered.
 *
 * Comparison base matches the rest of this file's text comparisons
 * (lowercase, diacritics stripped, apostrophes normalized), but deliberately
 * NOT an exact-substring test: the model may reformulate an alternative
 * ("venerdì" for "venerdì stessa ora"), so grounding is measured as the
 * fraction of the alternative's OWN words that also appear in lastMessage.
 * Threshold 0.5: these strings are short (often two or three words, e.g.
 * "la fai tu"), so requiring every word breaks on a legitimate one-word
 * rewrite, while accepting anything looser would let an alternative built
 * from one real word and one invented word through.
 *
 * Round 2 (found by review, no threshold separates the two populations —
 * raising it to 1.0 closes the number/name cases below but also drops
 * legitimate rewordings like "la faccio io" and "rimandare alla settimana
 * prossima"): numbers and proper nouns are the two classes where a WRONG
 * value still scores well on the word-overlap threshold, because the
 * surrounding words carry the score and the wrong value itself is either
 * invisible to it (a digit) or just one vote among several (a name). Both
 * are checked separately, by exact membership, alongside the threshold.
 */
export function isAlternativeGrounded(alt: string, lastMessage: string): boolean {
  const altWords = groundingWords(alt);
  if (altWords.size === 0) return false;
  const ctxWords = groundingWords(lastMessage);
  let hit = 0;
  for (const w of altWords) if (ctxWords.has(w)) hit += 1;
  if (hit / altWords.size < 0.5) return false;
  return numbersGrounded(alt, lastMessage) && properNounsGrounded(alt, lastMessage);
}

/**
 * The one production call site of AxContextReader.read (Global Constraint 5,
 * spec privacy 3): nothing else in the app reads the screen, and it happens
 * only inside onHotkey.
 */
export class ReplyCoordinator {
  private state: ReplyCoordinatorState = "idle";
  /** Bumped on every hotkey, dismiss, accept and PTT arm; an async step whose
   *  epoch no longer matches drops its result instead of raising a pill. */
  private epoch = 0;
  private pending: Pending | null = null;
  private blockedBundleId: string | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (cb: () => void, ms: number) => () => void;

  constructor(private readonly deps: ReplyCoordinatorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.setTimer = deps.setTimer ?? ((cb, ms) => { const t = setTimeout(cb, ms); return () => clearTimeout(t); });
  }

  getState(): ReplyCoordinatorState { return this.state; }
  isBusy(): boolean { return this.state !== "idle"; }
  /** For the preferences window's "Add <bundleId>" button (§Deviazioni 3). */
  lastBlockedBundleId(): string | null { return this.blockedBundleId; }

  async onHotkey(): Promise<void> {
    if (this.state === "suggesting") { this.dismiss("hotkey-toggle"); return; }
    if (this.state !== "idle") { void this.ignored("busy"); return; }

    const prefs = await this.deps.loadPrefs();
    if (!prefs.enabled) { void this.ignored("disabled"); return; }
    if (this.deps.dictationBusy()) { void this.ignored("dictation-busy"); return; }

    const serverState = this.deps.server.getState();
    if (!this.deps.server.isReady()) {
      if (serverState === "starting" || serverState === "downloading") return this.blocked("server-not-ready", FLASH_TEXT.modelLoading, { serverState });
      if (serverState === "failed") return this.blocked("server-failed", FLASH_TEXT.modelFailed, { serverState });
      void this.ignored("server-off");
      return;
    }
    if (prefs.userDisplayName.trim().length === 0) return this.blocked("no-user-name", FLASH_TEXT.noUserName);
    if (!this.deps.reader.isTrusted()) {
      void this.deps.logger.warn("reply trust-required", { reason: "trust-required" });
      this.deps.onTrustRequired?.();
      return;
    }

    // This is the one place in production that builds a BundleIdFilter from
    // a stored preference value. AxContextReader.isAppAllowed treats an
    // EMPTY allowlist as "refuse everyone" (its own stage-1 probe relies on
    // exactly that) but an EMPTY blocklist as "refuse no one" — universal
    // permission. A blocklist preference that is unset or was emptied out
    // must not silently turn into "read any app, anywhere": fail closed
    // instead of ever reading in that configuration.
    const filter: BundleIdFilter = { mode: prefs.appsMode, bundleIds: prefs.apps };
    if (filter.mode === "blocklist" && filter.bundleIds.length === 0) {
      void this.ignored("no-apps-configured");
      return;
    }

    const epoch = ++this.epoch;
    const deadline = this.sleep(TOTAL_TIMEOUT_MS);
    this.state = "reading";
    // `reading` is emitted but the window is NOT shown yet: the pill sits
    // bottom-center, and showing it before the addon call would put it under
    // the cursor — the addon would then read the overlay (bundle id of
    // open-flow → app-not-allowed) instead of the conversation. The read is
    // synchronous and ~150 ms measured; the wait worth showing is `thinking`.
    this.deps.overlay.sendState("reading");

    try {
      const frontBefore = this.deps.reader.frontmostPid();
      const read = this.deps.reader.read(filter);
      if (!read.ok) {
        if (read.reason === "app-not-allowed") {
          this.blockedBundleId = read.bundleId;
          return this.blocked("app-not-allowed", FLASH_TEXT.appNotAllowed, { bundleId: read.bundleId });
        }
        return this.abstain(read.reason, epoch, readerLogMeta(read));
      }
      const ctx = read.context;
      if (ctx.pid !== frontBefore) {
        // Reading a background window and pasting into the active app would be
        // the worst possible mistake (spec §9.2).
        return this.abstain("not-frontmost", epoch, { pid: ctx.pid, frontmostPid: frontBefore, bundleId: ctx.bundleId });
      }

      const parsed = this.deps.parse({ fragments: ctx.fragments, userDisplayName: prefs.userDisplayName, tailBudgetChars: TAIL_BUDGET_CHARS });
      if (parsed.kind === "abstain") return this.abstain(parsed.reason, epoch, parserLogMeta(parsed));

      this.state = "thinking";
      this.deps.overlay.sendState("thinking");
      this.deps.overlay.show();

      if (this.deps.preGate && !this.deps.preGate(parsed.lastMessage)) {
        return this.abstain("no-explicit-proposal", epoch, parserLogMeta(parsed));
      }

      const cls = await raced(this.deps.classify({
        transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
      }), deadline);
      if (epoch !== this.epoch) return;
      if (!cls.ok) return this.abstain("timeout", epoch);
      if (!cls.value.ok) {
        if (cls.value.reason === "llm-error") return this.serverError(cls.value.error, epoch);
        return this.abstain(cls.value.reason, epoch, { durationMs: cls.value.durationMs });
      }
      const classification = cls.value.classification;

      // The classifier DECLARES the language; parse() MEASURES it on the real
      // text. When both have an opinion and they disagree, the measurement
      // wins: measured on the real model, an entirely-English conversation
      // made the classifier say "it" and all three variants came back in
      // Italian (found by review — none of the 114 tests in these three
      // modules exercise a language disagreement, because they are all it/it).
      // The "both non-other" guard is essential, not decorative:
      // guessLanguage mis-measures Romance languages it doesn't know about
      // (measured: Spanish → "it", French → "it"), and on those the
      // classifier saying "other" (meaning "same language as the transcript",
      // with the filter's language rule disabled) is the better answer. The
      // guard lets the measurement win only on the it/en disagreement that
      // was actually observed.
      const language = parsed.languageGuess !== "other" && classification.language !== "other"
          && parsed.languageGuess !== classification.language
        ? parsed.languageGuess
        : classification.language;

      // Degrade to the `generic` set — the same conservative fallback this
      // feature uses elsewhere — instead of ever showing two alternatives
      // the counterpart never actually offered (Important 4).
      const alternativesGrounded = classification.alternatives === undefined
        || classification.alternatives.every((a) => isAlternativeGrounded(a, parsed.lastMessage));
      const kind = alternativesGrounded ? classification.kind : "generic";
      const alternatives = alternativesGrounded ? classification.alternatives : undefined;

      const positions = positionsFor({
        kind, language,
        ...(alternatives ? { alternatives } : {}),
      });
      const genInput: GenerateInput = {
        transcript: parsed.transcript, lastMessage: parsed.lastMessage, counterpart: parsed.counterpart,
        userDisplayName: prefs.userDisplayName, subject: parsed.subject, positions, language,
      };
      const gen = await raced(this.deps.generate(genInput), deadline);
      if (epoch !== this.epoch) return;
      if (!gen.ok) return this.abstain("timeout", epoch);
      if (!gen.value.ok) return this.serverError(gen.value.error, epoch);

      const filtered = this.deps.filterVariants({
        variants: gen.value.variants, lastMessage: parsed.lastMessage, transcript: parsed.transcript,
        counterpart: parsed.counterpart, userDisplayName: prefs.userDisplayName, language,
      });
      void this.deps.logger.info("reply filter", { ...filterLogMeta(filtered), kind });
      if (filtered.kept.length < MIN_KEPT) {
        // One proposal is not a choice, and reads as an authoritative
        // suggestion: no pill at all (decision 6).
        return this.abstain("too-few-variants", epoch, filterLogMeta(filtered));
      }

      this.showSuggestions(filtered.kept.slice(0, MAX_VARIANTS), parsed.gist, ctx.pid, ctx.editableIsFocused, {
        kind, language,
      });
    } catch (err) {
      // `reader.read` calls the native addon: an N-API throw is plausible.
      // Without this, the pipeline would stay stuck mid-flight forever —
      // isBusy() permanently true, every later hotkey "busy", the pill
      // parked on the thinking spinner with no way to dismiss() it (that
      // requires state "suggesting"). The feature must recover on its own.
      this.recoverFromError(err, epoch);
    }
  }

  private showSuggestions(kept: readonly FilterVariant[], gist: string, pid: number, editableIsFocused: boolean, meta: Record<string, unknown>): void {
    const variants: SuggestionVariant[] = kept.map((v, i) => ({ id: (i + 1) as 1 | 2 | 3, label: v.label, text: v.text }));
    const payload: SuggestionPayload = { gist, variants };
    const accelerators = [...VARIANT_ACCELERATORS.slice(0, variants.length), ESCAPE_ACCELERATOR];
    const cancelTtl = this.setTimer(() => this.dismiss("timeout-ttl"), SUGGEST_TTL_MS);
    this.pending = { payload, texts: kept.map((v) => v.text), pid, editableIsFocused, accelerators, cancelTtl };
    this.state = "suggesting";
    for (const [i, acc] of accelerators.entries()) {
      const ok = i < variants.length
        ? this.deps.shortcuts.register(acc, () => { void this.accept(i + 1); })
        : this.deps.shortcuts.register(acc, () => { this.dismiss("esc"); });
      if (!ok) void this.deps.logger.warn("reply shortcut not registered", { accelerator: acc });
    }
    this.deps.overlay.showSuggestions(payload);
    void this.deps.logger.info("reply suggesting", { ...meta, variants: variants.length, gistChars: gist.length, pid, editableIsFocused });
  }

  /** The user picked variant `id` (1-based), by mouse or by Command+N. */
  async accept(id: number): Promise<void> {
    const pending = this.pending;
    if (this.state !== "suggesting" || !pending) { void this.ignored("not-suggesting"); return; }
    const text = pending.texts[id - 1];
    if (text === undefined) { void this.ignored("unknown-variant"); return; }

    const epoch = ++this.epoch;
    this.releasePending("accept");
    this.state = "injecting";
    this.deps.overlay.resetSize();
    this.deps.overlay.sendState("injecting");

    try {
      if (!pending.editableIsFocused) {
        // The field was found through AXEditableAncestor and is NOT the focused
        // one: a ⌘V would land somewhere we never verified (spec §9.3).
        return this.degradeToClipboard(text, "editable-not-focused", epoch);
      }
      this.deps.reader.activateApp(pending.pid);
      if (!(await this.waitForFrontmost(pending.pid))) {
        return this.degradeToClipboard(text, "activate-failed", epoch);
      }
      // onDictationArm bumps the epoch but cannot cancel a paste already in
      // flight (Minor 8.2): pressing ⌘1 and immediately holding Option — a
      // window of up to ACTIVATE_TIMEOUT_MS — used to still fire this
      // paste on top of the dictation that wins by spec, producing two
      // pastes. Same epoch check onHotkey already uses after its own awaits.
      if (epoch !== this.epoch) {
        // A bare `return` here was silent (round 2, found by review): when
        // this guard is what stops the second paste, the log carried no
        // record that it happened at all. A code only, same as every other
        // line this feature logs.
        void this.deps.logger.info("reply accept aborted", { reason: "epoch-superseded" });
        return;
      }
      const result = await this.deps.inject(text);
      if (!result.pasted) {
        // TextInjector already left the text in the clipboard on failure.
        void this.deps.logger.warn("reply inject failed", { reason: "paste-failed", chars: text.length });
        return this.flashThenIdle(FLASH_TEXT.copyOnly, FLASH_INFO_MS, epoch);
      }
      void this.deps.logger.info("reply accepted", { result: "pasted", variant: id, chars: text.length, pid: pending.pid });
      await this.toIdle(epoch, HIDE_DELAY_MS);
    } catch (err) {
      // `activateApp` and `frontmostPid` also call the native addon.
      this.recoverFromError(err, epoch);
    }
  }

  /** Closes the pill for any reason; always releases the shortcuts. */
  dismiss(reason: DismissReason): void {
    if (this.state !== "suggesting" || !this.pending) return;
    this.epoch += 1;
    this.releasePending(reason);
    this.state = "idle";
    this.deps.overlay.resetSize();
    this.deps.overlay.sendState("idle");
    this.deps.overlay.hide();
  }

  /** The mouse entered the pill: restart the 20 s auto-close (spec §7). */
  onHover(): void {
    if (this.state !== "suggesting" || !this.pending) return;
    this.pending.cancelTtl();
    this.pending.cancelTtl = this.setTimer(() => this.dismiss("timeout-ttl"), SUGGEST_TTL_MS);
  }

  /** The user pressed Option to dictate: dictation wins, always. */
  onDictationArm(): void {
    if (this.state === "suggesting") { this.dismiss("ptt-arm"); return; }
    if (this.state === "idle") return;
    this.epoch += 1;
    this.state = "idle";
    this.deps.overlay.resetSize();
    // Explicit, rather than relying on the overlay's own onStateChange
    // listener (shared with dictation) to repaint over it: this abort path
    // must not depend on a side effect of another subsystem.
    this.deps.overlay.hide();
    void this.deps.logger.info("reply ignored", { reason: "ptt-arm" });
  }

  private releasePending(reason: string): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.cancelTtl();
    for (const acc of pending.accelerators) this.deps.shortcuts.unregister(acc);
    void this.deps.logger.info("reply dismissed", { reason });
  }

  private async waitForFrontmost(pid: number): Promise<boolean> {
    for (let waited = 0; waited <= ACTIVATE_TIMEOUT_MS; waited += ACTIVATE_POLL_MS) {
      if (this.deps.reader.frontmostPid() === pid) return true;
      await this.sleep(ACTIVATE_POLL_MS);
    }
    return this.deps.reader.frontmostPid() === pid;
  }

  private async degradeToClipboard(text: string, reason: string, epoch: number): Promise<void> {
    this.deps.copyToClipboard(text);
    void this.deps.logger.info("reply accepted", { result: "clipboard-only", reason, chars: text.length });
    await this.flashThenIdle(FLASH_TEXT.copyOnly, FLASH_INFO_MS, epoch);
  }

  private async abstain(reason: string, epoch: number, meta: Record<string, unknown> = {}): Promise<void> {
    // `meta` first: some ReadContextResult/ParseResult log-meta shapes carry
    // their own `reason` field (null for a non-abstain ParseResult, as with
    // the pre-gate's "no-explicit-proposal"), and the explicit `reason`
    // argument must always be the one that lands in the log.
    //
    // Logged BEFORE the epoch check below, deliberately: a stale/superseded
    // run (a PTT arm bumped the epoch while this was in flight) still logs
    // its own "reply abstain" line. That line is metrics/codes only, same as
    // every other one this feature writes, so it carries no privacy risk —
    // and it is useful on its own: it is the only record of what the
    // abandoned run would have decided.
    void this.deps.logger.info("reply abstain", { ...meta, reason });
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("nothing");
    this.deps.overlay.show();
    await this.toIdle(epoch, FLASH_NOTHING_MS);
  }

  private async blocked(reason: string, text: string, meta: Record<string, unknown> = {}): Promise<void> {
    // `meta` first, same as `abstain`: none of this method's callers pass a
    // `meta` with its own `reason` field today, but the explicit argument
    // must always win if one ever does.
    void this.deps.logger.info("reply blocked", { ...meta, reason });
    const epoch = ++this.epoch;
    this.state = "idle";
    await this.flashThenIdle(text, FLASH_INFO_MS, epoch);
  }

  private async serverError(error: string, epoch: number): Promise<void> {
    void this.deps.logger.error("reply server error", { reason: "llm-error", error });
    void this.deps.server.recover();
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("error");
    this.deps.overlay.show();
    await this.toIdle(epoch, ERROR_PILL_MS);
  }

  private async flashThenIdle(text: string, ms: number, epoch: number): Promise<void> {
    this.deps.overlay.sendFlash(text);
    await this.toIdle(epoch, ms);
  }

  private async toIdle(epoch: number, afterMs: number): Promise<void> {
    await this.sleep(afterMs);
    if (epoch !== this.epoch) return;
    this.state = "idle";
    this.deps.overlay.sendState("idle");
    this.deps.overlay.hide();
  }

  private async ignored(reason: string): Promise<void> {
    void this.deps.logger.info("reply ignored", { reason });
  }

  /** An unhandled throw/rejection from `onHotkey` or `accept` — plausible
   *  from either, since both call into the native addon (`reader.read`,
   *  `reader.activateApp`, `reader.frontmostPid`). Without this the pipeline
   *  would stay stuck exactly where it was: isBusy() permanently true, every
   *  later hotkey answered "busy", the pill parked on whatever it was
   *  showing with no way to dismiss() it (that requires state "suggesting").
   *  The error is always logged (a code only); the state/overlay/pending
   *  recovery itself is skipped only if a newer run (a dismiss or PTT arm)
   *  already moved past this epoch and recovered on its own. */
  private recoverFromError(err: unknown, epoch: number): void {
    void this.deps.logger.error("reply error", { reason: "exception", code: errorCode(err) });
    if (epoch !== this.epoch) return; // superseded by a dismiss/arm that already recovered
    if (this.pending) {
      this.pending.cancelTtl();
      for (const acc of this.pending.accelerators) this.deps.shortcuts.unregister(acc);
      this.pending = null;
    }
    this.state = "idle";
    this.deps.overlay.sendState("idle");
    this.deps.overlay.hide();
  }
}
