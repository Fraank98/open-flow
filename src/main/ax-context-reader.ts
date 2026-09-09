import { createRequire } from "node:module";
import { join } from "node:path";
import type { Logger } from "./logger.js";
// The plan's Global Constraints forbid the reader importing the parser, to
// keep the layers independent. The spec is the authority here and does not:
// this reuses the parser's exact fragment-splitting regex instead of keeping
// a byte-for-byte duplicate in this file (final review, correction 6).
import { normalizeFragments, SENTENCE_MIN } from "./utils/conversation-parser.js";

export type NativeReason =
  | "no-element" | "no-editable" | "no-text" | "budget-exceeded" | "ax-error" | "app-not-allowed";

export interface BundleIdFilter {
  mode: "allowlist" | "blocklist";
  bundleIds: readonly string[];
}

/** The addon's budgets. Separated from the filter so DEFAULT_READ_OPTIONS
 *  cannot carry one: a read without a filter must not be expressible. */
export interface ReadBudgets {
  maxDepth: number;
  maxTotalChars: number;
  timeBudgetMs: number;
  jumpRatio: number;
  jumpMinChars: number;
  /** Enables the WebKit text-marker safety net in the addon (and, as a
   *  consequence, the marker-line split below). Default false: the marker
   *  path was never exercised by any build in three rounds of fixes, and it
   *  carries privacy risk (spec, privacy 5 — see the addon's step 9) until
   *  someone deliberately measures its benefit (final review, correction 4). */
  textMarkers: boolean;
}

/** What the addon actually receives. The filter is mandatory: after Plan B
 *  there is no code path that harvests text before the app was permitted
 *  (spec §Privacy 4). */
export interface ReadOptions extends ReadBudgets {
  bundleIdFilter: BundleIdFilter;
}

/** Spec §1 budgets: depth 8 covers the measured jump at level 7 with one level
 *  of margin; 16 000 chars is twice the largest measured level (8 291); 300 ms
 *  is about twice the worst measured total (49 + 98 ms); 10× / 400 chars sit
 *  between the measured pre-jump (20-93 chars) and post-jump (1 454-8 291, 40-200×).
 *  textMarkers is off: see the field doc above. */
export const DEFAULT_READ_OPTIONS: Readonly<ReadBudgets> = {
  maxDepth: 8,
  maxTotalChars: 16_000,
  timeBudgetMs: 300,
  jumpRatio: 10,
  jumpMinChars: 400,
  textMarkers: false,
};

/** Stage 1 filter. An empty allowlist matches nothing, so the addon refuses
 *  every app with `app-not-allowed` BEFORE it harvests anything — and its
 *  refusal still carries pid and bundleId. That is what makes the exact-case
 *  id available to stage 2 without touching native/ (§Deviazioni 2).
 *
 *  This constant is the entire guarantee that stage 1 collects nothing: it
 *  must stay an empty array forever. `Readonly<BundleIdFilter>` alone only
 *  protects `mode` from reassignment at compile time — `bundleIds` was typed
 *  `string[]`, so `PROBE_FILTER.bundleIds.push(...)` used to compile, and the
 *  same object is handed to the addon (and recorded by test doubles) on every
 *  stage-1 call, so a mutated recorded call would have polluted this constant
 *  for the rest of the process (round-1 review finding). `bundleIds` is now
 *  `readonly string[]` on the type, and both the object and the array are
 *  frozen so mutation fails at runtime too, even through a type-level bypass
 *  (a cast, `as any`, plain JS). */
export const PROBE_FILTER: Readonly<BundleIdFilter> = Object.freeze({
  mode: "allowlist",
  bundleIds: Object.freeze([]),
});

export function normalizeBundleId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * macOS treats bundle ids case-insensitively; the addon's [NSSet
 * containsObject:] does not. The wrapper owns the comparison.
 *
 * An app that reports no bundle id cannot be matched against either list, so
 * it is refused in BOTH modes: an unidentifiable app was never knowingly
 * permitted by the user, and `blocklist` must not become a way in.
 */
export function isAppAllowed(bundleId: string, filter: BundleIdFilter): boolean {
  const id = normalizeBundleId(bundleId);
  if (id.length === 0) return false;
  const listed = filter.bundleIds.some((b) => normalizeBundleId(b) === id);
  return filter.mode === "allowlist" ? listed : !listed;
}

export interface NativeLevel { depth: number; chars: number; fragments: string[]; truncated: boolean }

export interface NativeContextResult {
  ok: boolean;
  /** Only present when ok is false. */
  reason?: NativeReason;
  pid: number;
  bundleId: string;
  editableFound: boolean;
  editableIsFocused: boolean;
  levels: NativeLevel[];
  chosenLevel: number;
  /** Omitted when the addon found no WebKit text marker. */
  webkitMarkerText?: string;
  /** AXError of setting AXManualAccessibility on the app element; log only.
   *  Omitted when the addon didn't reach that step. */
  axManualAccessibility?: number;
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number };
}

export interface AxContextNative {
  readContextUnderCursor(opts: ReadOptions): NativeContextResult;
  activateApp(pid: number): boolean;
  frontmostPid(): number;
  isTrusted(): boolean;
}

/** truncated: true when the addon hit kSubtreeMaxNodes collecting this level
 *  (a per-level cap on harvested nodes) — the level's chars/fragments may be
 *  incomplete. Without this, a capped level and a complete one look alike,
 *  which is exactly what the jump ratio compares (final review, correction 5). */
export interface LevelSummary { depth: number; chars: number; n: number; truncated: boolean }

export interface RawContext {
  pid: number;
  bundleId: string;
  editableFound: boolean;
  editableIsFocused: boolean;
  chosenLevel: number;
  levelSummary: LevelSummary[];
  /** Normalized fragments of the chosen level (richest level when no jump). */
  fragments: string[];
  /** WebKit marker-text diagnostics — counts only (spec, privacy 2). null
   *  when the addon didn't return a marker (textMarkers off, no jump, or a
   *  non-WebKit app). fragmentsTouched counts pre-split fragments that the
   *  marker lines actually replaced (final review, correction 8). */
  markerText: { chars: number; fragmentsTouched: number } | null;
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number; probeMs: number; wrapperMs: number };
}

export type ReadContextResult =
  | { ok: true; context: RawContext }
  | { ok: false; reason: NativeReason | "not-trusted" | "timeout"; pid: number; bundleId: string; levelSummary: LevelSummary[] };

export interface AxContextReaderOptions {
  appRoot?: string;
  isPackaged?: boolean;
  /** Injected addon, for tests. When given, appRoot/isPackaged are unused. */
  native?: AxContextNative;
  /** Receives metrics only — never text (spec, privacy 2). */
  logger?: Pick<Logger, "info" | "warn">;
  /** Outer safety timeout; 500 ms by default. */
  timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Loads the ax_context native addon. Deliberate duplicate of
 * `loadNativeAddon` in `ptt-manager.ts` (not exported there, and that file is
 * out of scope for this task): same two search paths, same error shape, only
 * the target filename differs.
 */
function loadNativeAddon(appRoot: string, isPackaged: boolean): AxContextNative {
  const require_ = createRequire(import.meta.url);
  const candidates = isPackaged
    ? [
        join(appRoot, "..", "app.asar.unpacked", "build", "Release", "ax_context.node"),
        join(appRoot, "build", "Release", "ax_context.node"),
      ]
    : [join(appRoot, "build", "Release", "ax_context.node")];
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      return require_(path) as AxContextNative;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not load ax_context.node. Tried: ${candidates.join(", ")}. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** Fragments of the chosen level, or of the level with the most chars when
 *  the addon found no jump (chosenLevel === -1). Empty when there are no levels. */
function pickFragments(result: NativeContextResult): string[] {
  if (result.levels.length === 0) return [];
  if (result.chosenLevel >= 0) {
    const level = result.levels[result.chosenLevel];
    if (level !== undefined) return level.fragments;
  }
  // No jump found (or an out-of-range index): fall back to the richest level
  // by char count. reduce() starts from levels[0], which exists (length > 0
  // was checked above), so `richest` is always a valid NativeLevel.
  const richest = result.levels.reduce((best, l) => (l.chars > best.chars ? l : best), result.levels[0]!);
  return richest.fragments;
}

/**
 * Parses a CLI numeric argument, throwing instead of returning `NaN` when it
 * isn't one. `Number("")`/`Number("abc")` degrade silently: in the probe
 * (final review, correction 8) a non-numeric `--delay` skipped the countdown
 * (`NaN > 0` is false, so the loop never ran) and a non-numeric `--budget`
 * slipped past `buildTranscript`'s minimum-budget guard (`NaN < 100` is also
 * false) instead of failing with a clear message. */
export function parseFiniteNumber(raw: string, label: string): number {
  // Number("") is 0 and Number("  ") is also 0 — neither is a number the
  // caller actually typed, so an empty/blank argument is rejected too, same
  // as any other non-numeric one.
  const n = raw.trim().length === 0 ? NaN : Number(raw);
  if (!Number.isFinite(n)) throw new RangeError(`${label} deve essere un numero finito, ricevuto: ${JSON.stringify(raw)}`);
  return n;
}

const MARKER_SPLIT_MIN_CHARS = 120;

/** A line produced by the marker split that, on its own, would be shorter
 *  than the parser's survival floor (SENTENCE_MIN, imported so the two never
 *  drift apart) is glued onto the piece being accumulated instead of being
 *  emitted as its own fragment — otherwise `keepContentful` drops it outright
 *  (final review, correction 1: this is exactly how a trailing question like
 *  "Le va bene giovedì o venerdì?" was disappearing on Mail bodies, since the
 *  AX tree's single long fragment got re-split into one short, unattributed
 *  piece per marker line and the short ones never survived phase 2). A line
 *  long enough to stand on its own always starts a new piece. */
function mergeShortLines(lines: readonly string[]): string[] {
  const merged: string[] = [];
  for (const line of lines) {
    if (line.length < SENTENCE_MIN && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${line}`;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

export interface MarkerSplitResult {
  fragments: string[];
  /** Count of pre-split fragments the marker lines actually replaced. */
  touched: number;
}

/**
 * WebKit safety net (spec §1.7): the AX tree loses paragraph breaks, the text
 * markers keep them. For every fragment of at least 120 chars, if a run of
 * two or more consecutive marker lines, joined by single spaces, equals the
 * fragment exactly, the fragment is replaced by those lines (short lines
 * merged into the preceding one, see `mergeShortLines`). Never adds text from
 * the marker string that is not already in the fragment: the marker text has
 * no scope (spike 1) and must not become a content source.
 */
export function splitByMarkerLinesDetailed(
  fragments: readonly string[],
  markerText: string | undefined,
): MarkerSplitResult {
  if (markerText === undefined) return { fragments: [...fragments], touched: 0 };
  const markerLines = markerText.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  if (markerLines.length < 2) return { fragments: [...fragments], touched: 0 };

  let touched = 0;
  const out = fragments.flatMap((fragment) => {
    if (fragment.length < MARKER_SPLIT_MIN_CHARS) return [fragment];
    const replacement = findCoveringRun(fragment, markerLines);
    if (!replacement) return [fragment];
    touched += 1;
    return mergeShortLines(replacement);
  });
  return { fragments: out, touched };
}

export function splitByMarkerLines(fragments: readonly string[], markerText: string | undefined): string[] {
  return splitByMarkerLinesDetailed(fragments, markerText).fragments;
}

/**
 * Looks for a contiguous run of `lines` (length >= 2) whose single-space join
 * equals `fragment` exactly; returns that run, or null if none match.
 *
 * Two guards keep this from being quadratic in practice (final review,
 * correction 2: 833 ms measured on 300 marker lines / ~18k chars with 20 long
 * fragments, 6.3 s on 600 lines — and unmeasured by the outer timeout, which
 * is read before this ever runs): a start line that isn't itself a prefix of
 * `fragment` cannot begin a matching run, so it is skipped without joining
 * anything; and the accumulated run is built incrementally and abandoned the
 * moment it is at least as long as `fragment`, instead of re-joining a
 * growing slice from scratch on every inner step.
 */
function findCoveringRun(fragment: string, lines: readonly string[]): string[] | null {
  for (let start = 0; start < lines.length; start++) {
    if (!fragment.startsWith(lines[start]!)) continue;
    let acc = lines[start]!;
    for (let end = start + 1; end < lines.length; end++) {
      if (acc.length >= fragment.length) break; // can only grow past fragment.length now
      acc = `${acc} ${lines[end]}`;
      if (acc.length > fragment.length) break; // overshot: this run cannot match
      if (acc === fragment) return lines.slice(start, end + 1);
    }
  }
  return null;
}

/** Metrics only. `fragments` is a COUNT. */
export function toLogMeta(r: ReadContextResult): Record<string, unknown> {
  if (r.ok) {
    return {
      ok: true,
      reason: null,
      pid: r.context.pid,
      bundleId: r.context.bundleId,
      editableFound: r.context.editableFound,
      editableIsFocused: r.context.editableIsFocused,
      chosenLevel: r.context.chosenLevel,
      levels: r.context.levelSummary,
      fragments: r.context.fragments.length,
      timings: r.context.timings,
    };
  }
  return {
    ok: false,
    reason: r.reason,
    pid: r.pid,
    bundleId: r.bundleId,
    editableFound: null,
    editableIsFocused: null,
    chosenLevel: null,
    levels: r.levelSummary,
    fragments: 0,
    timings: null,
  };
}

/**
 * Injectable wrapper over the ax_context native addon. Normalizes the raw AX
 * fragments of the chosen level into a `RawContext` ready for the
 * conversation parser (Task 8), applies an outer safety timeout on top of
 * the addon's own internal budget, and logs metrics only — never screen text.
 */
export class AxContextReader {
  private readonly native: AxContextNative;
  private readonly logger: Pick<Logger, "info" | "warn"> | null;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: AxContextReaderOptions) {
    this.native = opts.native ?? loadNativeAddon(opts.appRoot ?? "", opts.isPackaged ?? false);
    this.logger = opts.logger ?? null;
    this.timeoutMs = opts.timeoutMs ?? 500;
    this.now = opts.now ?? (() => performance.now());
  }

  isTrusted(): boolean { return this.native.isTrusted(); }
  frontmostPid(): number { return this.native.frontmostPid(); }
  activateApp(pid: number): boolean { return this.native.activateApp(pid); }

  /** Logs one "ax-context read" info line: metrics only, never text (spec,
   *  privacy 2). Every non-anomaly exit of `read()` below logged this exact
   *  same shape independently, seven times over (final review round 1,
   *  minor 3); `extra` lets one branch (the stage-1 timeout) attach a
   *  diagnostic field without growing a bespoke call. */
  private logRead(
    r: ReadContextResult,
    filterMeta: { filterMode: BundleIdFilter["mode"]; filterSize: number },
    probeMs: number,
    extra: Record<string, unknown> = {},
  ): void {
    void this.logger?.info("ax-context read", { ...toLogMeta(r), ...filterMeta, probeMs, ...extra });
  }

  /**
   * One read under the cursor, in two stages.
   *
   * Stage 1 asks the addon with an EMPTY allowlist: it refuses every app
   * before harvesting and reports pid + bundleId. Stage 2 runs only if the
   * wrapper, comparing case-insensitively, finds the app permitted — and it
   * passes back the addon's own spelling of the id, so the addon's
   * case-sensitive comparison agrees. Cost: one extra
   * AXUIElementCopyElementAtPosition (28-49 ms measured).
   *
   * `filter` is mandatory. The 500 ms outer timeout covers both stages: the
   * addon call is synchronous and cannot be interrupted, so an overrun is
   * rejected after the fact rather than trusted.
   */
  read(filter: BundleIdFilter, overrides: Partial<ReadBudgets> = {}): ReadContextResult {
    const budgets: ReadBudgets = { ...DEFAULT_READ_OPTIONS, ...overrides };
    const filterMeta = { filterMode: filter.mode, filterSize: filter.bundleIds.length };

    if (!this.native.isTrusted()) {
      const r: ReadContextResult = { ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] };
      void this.logger?.warn("ax-context read blocked", { ...toLogMeta(r), ...filterMeta });
      return r;
    }

    // ── Stage 1: identify the app. No harvest happens here, so it gets no
    // harvest budget: textMarkers is forced off regardless of what the
    // caller asked for, instead of inviting the addon to build the WebKit
    // marker text (privacy risk 5, spec) for a call whose result is always
    // discarded (round-1 review: defense in depth, free). ──
    const t0 = this.now();
    const probe = this.native.readContextUnderCursor({ ...budgets, textMarkers: false, bundleIdFilter: PROBE_FILTER });
    const probeMs = this.now() - t0;
    const refuse = (): ReadContextResult => ({
      ok: false, reason: "app-not-allowed", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [],
    });

    if (probeMs > this.timeoutMs) {
      const r: ReadContextResult = { ok: false, reason: "timeout", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [] };
      // probeOk: this check runs BEFORE the probe.ok anomaly check below, so
      // a probe that both blew its budget AND wrongly said ok:true (empty
      // allowlist not refused) would otherwise be reported as a plain
      // timeout, and the addon/wrapper disagreement would never be logged
      // (round-1 review, minor 5). Neither branch's `reason` changes: both
      // already fail closed.
      this.logRead(r, filterMeta, probeMs, { probeOk: probe.ok });
      return r;
    }
    if (probe.ok) {
      // The addon did not refuse an empty allowlist, so it may also have
      // harvested text it was not allowed to. Its result is discarded and the
      // read fails closed; the anomaly is logged because it means the addon
      // and this wrapper disagree on the gate.
      void this.logger?.warn("ax-context probe anomaly: empty allowlist was not refused", { ...filterMeta, probeMs, pid: probe.pid, bundleId: probe.bundleId });
      return refuse();
    }
    if (probe.reason !== "app-not-allowed") {
      const r: ReadContextResult = {
        ok: false, reason: probe.reason ?? "ax-error", pid: probe.pid, bundleId: probe.bundleId, levelSummary: [],
      };
      this.logRead(r, filterMeta, probeMs);
      return r;
    }
    if (!isAppAllowed(probe.bundleId, filter)) {
      const r = refuse();
      this.logRead(r, filterMeta, probeMs);
      return r;
    }

    // ── Stage 2: permitted. Harvest. ──
    const opts: ReadOptions = { ...budgets, bundleIdFilter: { mode: "allowlist", bundleIds: [probe.bundleId] } };
    const t1 = this.now();
    const native = this.native.readContextUnderCursor(opts);
    const wrapperMs = probeMs + (this.now() - t1);
    const levelSummary = native.levels.map((l) => ({ depth: l.depth, chars: l.chars, n: l.fragments.length, truncated: l.truncated }));

    if (wrapperMs > this.timeoutMs) {
      const r: ReadContextResult = { ok: false, reason: "timeout", pid: native.pid, bundleId: native.bundleId, levelSummary };
      this.logRead(r, filterMeta, probeMs);
      return r;
    }

    if (!native.ok) {
      const r: ReadContextResult = {
        ok: false,
        reason: native.reason ?? "ax-error",
        pid: native.pid,
        bundleId: native.bundleId,
        levelSummary,
      };
      this.logRead(r, filterMeta, probeMs);
      return r;
    }

    const preSplit = normalizeFragments(pickFragments(native));
    const split = splitByMarkerLinesDetailed(preSplit, native.webkitMarkerText);
    const fragments = split.fragments;

    if (fragments.length === 0) {
      const r: ReadContextResult = { ok: false, reason: "no-text", pid: native.pid, bundleId: native.bundleId, levelSummary };
      this.logRead(r, filterMeta, probeMs);
      return r;
    }

    const r: ReadContextResult = {
      ok: true,
      context: {
        pid: native.pid,
        bundleId: native.bundleId,
        editableFound: native.editableFound,
        editableIsFocused: native.editableIsFocused,
        chosenLevel: native.chosenLevel,
        levelSummary,
        fragments,
        markerText: native.webkitMarkerText === undefined
          ? null
          : { chars: native.webkitMarkerText.length, fragmentsTouched: split.touched },
        timings: { ...native.timings, probeMs, wrapperMs },
      },
    };
    this.logRead(r, filterMeta, probeMs);
    return r;
  }
}
