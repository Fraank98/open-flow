import { createRequire } from "node:module";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export type NativeReason =
  | "no-element" | "no-editable" | "no-text" | "budget-exceeded" | "ax-error" | "app-not-allowed";

export interface BundleIdFilter {
  mode: "allowlist" | "blocklist";
  bundleIds: string[];
}

export interface ReadOptions {
  maxDepth: number;
  maxTotalChars: number;
  timeBudgetMs: number;
  jumpRatio: number;
  jumpMinChars: number;
  /** Checked by the addon BEFORE any harvest (spec, privacy 4). */
  bundleIdFilter?: BundleIdFilter;
}

/** Spec §1 budgets: depth 8 covers the measured jump at level 7 with one level
 *  of margin; 16 000 chars is twice the largest measured level (8 291); 300 ms
 *  is about twice the worst measured total (49 + 98 ms); 10× / 400 chars sit
 *  between the measured pre-jump (20-93 chars) and post-jump (1 454-8 291, 40-200×). */
export const DEFAULT_READ_OPTIONS: Readonly<ReadOptions> = {
  maxDepth: 8,
  maxTotalChars: 16_000,
  timeBudgetMs: 300,
  jumpRatio: 10,
  jumpMinChars: 400,
};

export interface NativeLevel { depth: number; chars: number; fragments: string[] }

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

export interface LevelSummary { depth: number; chars: number; n: number }

export interface RawContext {
  pid: number;
  bundleId: string;
  editableFound: boolean;
  editableIsFocused: boolean;
  chosenLevel: number;
  levelSummary: LevelSummary[];
  /** Normalized fragments of the chosen level (richest level when no jump). */
  fragments: string[];
  timings: { elementAtPositionMs: number; collectMs: number; totalMs: number; wrapperMs: number };
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

const FRAGMENT_SPLIT = /\s*⋄\s*|\r?\n/u;

/** Splits on the " ⋄ " separator and on newlines, trims, collapses internal
 *  whitespace, drops empties and exact duplicates; order preserved. */
export function normalizeNativeFragments(fragments: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of fragments) {
    for (const piece of raw.split(FRAGMENT_SPLIT)) {
      const cleaned = piece.trim().replace(/\s+/gu, " ");
      if (cleaned.length === 0) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

/** Fragments of the chosen level, or of the level with the most chars when
 *  the addon found no jump (chosenLevel === -1). Empty when there are no levels. */
export function pickFragments(result: NativeContextResult): string[] {
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

const MARKER_SPLIT_MIN_CHARS = 120;

/**
 * WebKit safety net (spec §1.7): the AX tree loses paragraph breaks, the text
 * markers keep them. For every fragment of at least 120 chars, if a run of
 * two or more consecutive marker lines, joined by single spaces, equals the
 * fragment exactly, the fragment is replaced by those lines. Never adds text
 * from the marker string that is not already in the fragment: the marker
 * text has no scope (spike 1) and must not become a content source.
 */
export function splitByMarkerLines(fragments: readonly string[], markerText: string | undefined): string[] {
  if (markerText === undefined) return [...fragments];
  const markerLines = markerText.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l.length > 0);
  if (markerLines.length < 2) return [...fragments];

  return fragments.flatMap((fragment) => {
    if (fragment.length < MARKER_SPLIT_MIN_CHARS) return [fragment];
    const replacement = findCoveringRun(fragment, markerLines);
    return replacement ?? [fragment];
  });
}

/** Looks for a contiguous run of `lines` (length >= 2) whose single-space
 *  join equals `fragment` exactly; returns that run, or null if none match. */
function findCoveringRun(fragment: string, lines: readonly string[]): string[] | null {
  for (let start = 0; start < lines.length; start++) {
    for (let end = start + 1; end < lines.length; end++) {
      // Slice is non-empty by construction (end > start >= 0, within bounds).
      const run = lines.slice(start, end + 1);
      if (run.join(" ") === fragment) return run;
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

  /**
   * One synchronous read under the cursor. The addon call cannot be
   * interrupted (it is synchronous on the main thread, like every ptt_monitor
   * call), so the 500 ms outer timeout is enforced after the fact: a call that
   * overran is rejected as "timeout" rather than trusted, because an addon that
   * ignored its own budget may also have ignored its depth limit.
   */
  read(overrides: Partial<ReadOptions> = {}): ReadContextResult {
    if (!this.native.isTrusted()) {
      const r: ReadContextResult = { ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] };
      void this.logger?.warn("ax-context read blocked", toLogMeta(r));
      return r;
    }

    const opts: ReadOptions = { ...DEFAULT_READ_OPTIONS, ...overrides };
    const t0 = this.now();
    const native = this.native.readContextUnderCursor(opts);
    const wrapperMs = this.now() - t0;
    const levelSummary = native.levels.map((l) => ({ depth: l.depth, chars: l.chars, n: l.fragments.length }));

    if (wrapperMs > this.timeoutMs) {
      const r: ReadContextResult = { ok: false, reason: "timeout", pid: native.pid, bundleId: native.bundleId, levelSummary };
      void this.logger?.info("ax-context read", toLogMeta(r));
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
      void this.logger?.info("ax-context read", toLogMeta(r));
      return r;
    }

    const fragments = splitByMarkerLines(normalizeNativeFragments(pickFragments(native)), native.webkitMarkerText);

    if (fragments.length === 0) {
      const r: ReadContextResult = { ok: false, reason: "no-text", pid: native.pid, bundleId: native.bundleId, levelSummary };
      void this.logger?.info("ax-context read", toLogMeta(r));
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
        timings: { ...native.timings, wrapperMs },
      },
    };
    void this.logger?.info("ax-context read", toLogMeta(r));
    return r;
  }
}
