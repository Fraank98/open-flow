import { describe, it, expect, vi } from "vitest";
import {
  AxContextReader,
  DEFAULT_READ_OPTIONS,
  isAppAllowed,
  normalizeBundleId,
  parseFiniteNumber,
  PROBE_FILTER,
  splitByMarkerLines,
  splitByMarkerLinesDetailed,
  toLogMeta,
  type AxContextNative,
  type BundleIdFilter,
  type NativeContextResult,
  type NativeLevel,
  type ReadOptions,
} from "../../src/main/ax-context-reader.js";
import { SENTENCE_MIN } from "../../src/main/utils/conversation-parser.js";
import { CASES, axFragments, leaksScreenText, type ConversationCase } from "../fixtures/conversations/spike-corpus.js";

const SLACK = "com.tinyspeck.slackmacgap";
const ALLOW_SLACK: BundleIdFilter = { mode: "allowlist", bundleIds: [SLACK] };
const ALLOW_SLACK_UPPER: BundleIdFilter = { mode: "allowlist", bundleIds: ["COM.TinySpeck.SlackMacGap"] };
const ALLOW_MAIL: BundleIdFilter = { mode: "allowlist", bundleIds: ["com.apple.mail"] };
const BLOCK_SLACK: BundleIdFilter = { mode: "blocklist", bundleIds: [" COM.TINYSPECK.SLACKMACGAP "] };
const BLOCK_MAIL: BundleIdFilter = { mode: "blocklist", bundleIds: ["com.apple.mail"] };

/** NativeLevel literals in this file default `truncated` to false unless a
 *  test cares about it (see the "truncated" describe block below). */
function lvl(depth: number, chars: number, fragments: string[], truncated = false): NativeLevel {
  return { depth, chars, fragments, truncated };
}

function okResult(over: Partial<NativeContextResult> = {}): NativeContextResult {
  return {
    ok: true,
    pid: 4242,
    bundleId: "com.tinyspeck.slackmacgap",
    editableFound: true,
    editableIsFocused: true,
    levels: [
      lvl(0, 17, ["Messaggio a Marta"]),
      lvl(1, 22, ["Messaggio a Marta", "Invia"]),
      lvl(2, 3748, ["Marta: ciao 09:12. ⋄ 09:12 ⋄ ciao", "Invia"]),
    ],
    chosenLevel: 2,
    axManualAccessibility: 0,
    timings: { elementAtPositionMs: 31, collectMs: 23, totalMs: 60 },
    ...over,
  };
}

/**
 * Two-stage native double. The identification probe is whichever call carries
 * an EMPTY allowlist (`PROBE_FILTER`'s exact shape): it always refuses with
 * `app-not-allowed` (that is what an empty allowlist does in the addon) and
 * still reports pid + bundleId. Every other call is the harvest and returns
 * `result`. `probeOver` lets a test bend the probe's answer (an unexpected
 * success, a different reason, an empty bundleId, levels that should be
 * ignored).
 *
 * The split is by the CONTRACT of the call (does its filter ask for nothing?)
 * rather than by the call count's parity. Parity is only an accident of the
 * happy path, where probe and harvest strictly alternate 1st/2nd, 3rd/4th,
 * etc.: after a REFUSED read, the next read's stage 1 probe lands on an even
 * call, and a parity-based double would hand it `result` instead of the
 * forced refusal — silently turning a permitted app's read into a false
 * refusal that looks identical to a real one (round-1 review finding: the
 * same refusal assertion passed even when the filter allowed the app). A
 * fresh two-stage dance still happens on every `.read()`, including a second
 * one on the same double (e.g. "does not enable textMarkers unless the
 * caller opts in"), because the shape check is stateless per call.
 */
function makeFakeNative(result: NativeContextResult, trusted = true, probeOver: Partial<NativeContextResult> = {}) {
  const calls: ReadOptions[] = [];
  const native: AxContextNative = {
    readContextUnderCursor: (opts) => {
      calls.push(opts);
      const isProbe = opts.bundleIdFilter.mode === "allowlist" && opts.bundleIdFilter.bundleIds.length === 0;
      if (isProbe) {
        return { ...result, ok: false, reason: "app-not-allowed", levels: [], chosenLevel: -1, ...probeOver };
      }
      return result;
    },
    activateApp: vi.fn(() => true),
    frontmostPid: vi.fn(() => 4242),
    isTrusted: () => trusted,
  };
  return { native, calls };
}

/** A logger that records every call as its serialized [msg, meta] pair, so
 *  privacy tests can scan the exact bytes a real logger would receive. */
function makeSpyLogger() {
  const seen: string[] = [];
  const logger = {
    info: vi.fn(async (msg: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([msg, meta])); }),
    warn: vi.fn(async (msg: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([msg, meta])); }),
  };
  return { logger, seen };
}

/** Fails unless at least one line was logged, and none of them leaks any
 *  fragment (or name) of the given corpus cases (spec, privacy 2). */
function assertNoLeak(seen: readonly string[], ...cases: readonly ConversationCase[]): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const line of seen) {
    for (const c of cases) {
      expect(leaksScreenText(line, c.ax), line).toBe(false);
    }
  }
}

describe("AxContextReader.read", () => {
  it("returns not-trusted without calling the native reader when Accessibility is not granted", () => {
    const fake = makeFakeNative(okResult(), false);
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r).toEqual({ ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the spec budgets to the addon on both stages, with a synthesized filter", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(DEFAULT_READ_OPTIONS).toEqual({
      maxDepth: 8, maxTotalChars: 16_000, timeBudgetMs: 300, jumpRatio: 10, jumpMinChars: 400, textMarkers: false,
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toEqual({ ...DEFAULT_READ_OPTIONS, bundleIdFilter: { mode: "allowlist", bundleIds: [] } });
    expect(fake.calls[1]).toEqual({ ...DEFAULT_READ_OPTIONS, bundleIdFilter: { mode: "allowlist", bundleIds: [SLACK] } });
  });

  it("does not enable textMarkers unless the caller opts in, and stage 1 never gets it even when the caller does (round-1 fix: stage 1 doesn't need any harvest budget)", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(fake.calls[0]?.textMarkers).toBe(false); // stage 1
    expect(fake.calls[1]?.textMarkers).toBe(false); // stage 2
    new AxContextReader({ native: fake.native }).read(ALLOW_SLACK, { textMarkers: true });
    expect(fake.calls[2]?.textMarkers).toBe(false); // stage 1: forced false regardless of the override
    expect(fake.calls[3]?.textMarkers).toBe(true); // stage 2: honors the override
  });

  it("maps a failed native result to ok:false with the native reason and the level counts", () => {
    const fake = makeFakeNative(okResult({ ok: false, reason: "no-editable", editableFound: false, levels: [], chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-editable");
    expect(r.pid).toBe(4242);
    expect(r.bundleId).toBe("com.tinyspeck.slackmacgap");
  });

  it("uses 'ax-error' when a failed result carries no reason", () => {
    const fake = makeFakeNative(okResult({ ok: false }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("ax-error");
  });

  it("returns the chosen level's fragments, normalized (⋄ split, trimmed, deduped)", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.fragments).toEqual(["Marta: ciao 09:12.", "09:12", "ciao", "Invia"]);
    expect(r.context.chosenLevel).toBe(2);
    expect(r.context.levelSummary).toEqual([
      { depth: 0, chars: 17, n: 1, truncated: false },
      { depth: 1, chars: 22, n: 2, truncated: false },
      { depth: 2, chars: 3748, n: 2, truncated: false },
    ]);
    expect(r.context.pid).toBe(4242);
    expect(r.context.editableIsFocused).toBe(true);
    expect(r.context.markerText).toBeNull();
  });

  it("computes wrapperMs over BOTH stages and reports probeMs separately", () => {
    const fake = makeFakeNative(okResult());
    const clock = [100, 110, 110, 137];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 137 }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.timings).toEqual({ elementAtPositionMs: 31, collectMs: 23, totalMs: 60, probeMs: 10, wrapperMs: 37 });
  });

  it("falls back to the richest level when the addon found no jump", () => {
    const fake = makeFakeNative(okResult({ chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.chosenLevel).toBe(-1);
    expect(r.context.fragments[0]).toBe("Marta: ciao 09:12.");
  });

  it("returns no-text when the chosen level normalizes to nothing", () => {
    const fake = makeFakeNative(okResult({ levels: [lvl(0, 3, ["   ", "⋄"])], chosenLevel: 0 }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("no-text");
  });

  it("rejects as 'timeout' a call that took longer than timeoutMs (500 by default)", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 40, 40, 501];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 501 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
  });

  it("accepts a call that took exactly timeoutMs", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 40, 40, 500];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 500 }).read(ALLOW_SLACK);
    expect(r.ok).toBe(true);
  });

  it("passes through isTrusted, frontmostPid and activateApp", () => {
    const fake = makeFakeNative(okResult());
    const reader = new AxContextReader({ native: fake.native });
    expect(reader.isTrusted()).toBe(true);
    expect(reader.frontmostPid()).toBe(4242);
    expect(reader.activateApp(4242)).toBe(true);
    expect(fake.native.activateApp).toHaveBeenCalledWith(4242);
  });
});

describe("AxContextReader — privacy", () => {
  const slack = CASES[0]!;   // slack-decisione
  const mail = CASES[2]!;    // mail-preventivo (used as marker text)

  it("non passa mai al logger testo letto dallo schermo (successo)", () => {
    const result = okResult({
      levels: [
        lvl(0, 17, ["Messaggio a Marta"]),
        lvl(7, slack.ax.length, axFragments(slack.ax)),
      ],
      chosenLevel: 1,
      webkitMarkerText: axFragments(mail.ax).join("\n"),
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r.ok).toBe(true);
    assertNoLeak(seen, slack, mail);
  });

  it("non passa mai al logger testo letto dallo schermo (not-trusted)", () => {
    // Real corpus content sits in the native result to prove that even a
    // native mock loaded with content leaks nothing when isTrusted() gates
    // the call before the native reader is ever invoked.
    const result = okResult({
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result, false);
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("not-trusted");
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (timeout, stadio 1)", () => {
    const result = okResult({
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const clock = [0, 501];
    const r = new AxContextReader({ native: fake.native, logger, now: () => clock.shift() ?? 501 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
    expect(fake.calls).toHaveLength(1); // this timeout fires before stage 2 ever runs
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (timeout, stadio 2 — l'unico timeout con metriche derivate da testo davvero raccolto)", () => {
    // Round-1 review finding: with the "(timeout)" test above scoped to
    // stage 1 (which never harvests), the stage-2 timeout branch
    // (ax-context-reader.ts, wrapperMs > timeoutMs after a real harvest) had
    // no non-leak assertion at all. probeMs=50 keeps stage 1 under budget so
    // stage 2 actually runs; wrapperMs=600 then blows the outer timeout AFTER
    // the addon returned real corpus fragments.
    const result = okResult({
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const clock = [0, 50, 50, 600];
    const r = new AxContextReader({ native: fake.native, logger, now: () => clock.shift() ?? 600 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
    expect(fake.calls).toHaveLength(2); // both stages ran; stage 2 harvested real text
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (nativo fallito)", () => {
    const result = okResult({
      ok: false,
      reason: "budget-exceeded",
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
      chosenLevel: -1,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("budget-exceeded");
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (no-text)", () => {
    // The chosen level (0) normalizes to nothing; a second, unchosen level
    // carries real corpus content, proving it never leaks via levelSummary.
    const result = okResult({
      levels: [
        lvl(0, 3, ["   ", "⋄"]),
        lvl(7, slack.ax.length, axFragments(slack.ax)),
      ],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("no-text");
    assertNoLeak(seen, slack);
  });

  it("toLogMeta exposes counts, codes, bundleId and timings only", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    const meta = toLogMeta(r);
    expect(Object.keys(meta).sort()).toEqual([
      "bundleId", "chosenLevel", "editableFound", "editableIsFocused", "fragments", "levels", "ok", "pid", "reason", "timings",
    ]);
    expect(meta.fragments).toBe(4); // a COUNT, never the strings
    expect(JSON.stringify(meta)).not.toContain("Marta");
  });
});

describe("isAppAllowed / normalizeBundleId", () => {
  it("normalizes case and surrounding whitespace, as macOS does", () => {
    expect(normalizeBundleId("  COM.Apple.Mail ")).toBe("com.apple.mail");
    expect(isAppAllowed("com.apple.mail", { mode: "allowlist", bundleIds: ["COM.APPLE.MAIL"] })).toBe(true);
    expect(isAppAllowed("COM.Apple.Mail", { mode: "allowlist", bundleIds: [" com.apple.mail "] })).toBe(true);
  });
  it("allowlist: only listed ids pass", () => {
    expect(isAppAllowed(SLACK, ALLOW_SLACK)).toBe(true);
    expect(isAppAllowed(SLACK, ALLOW_MAIL)).toBe(false);
    expect(isAppAllowed(SLACK, { mode: "allowlist", bundleIds: [] })).toBe(false);
  });
  it("blocklist: listed ids are refused, everything else passes", () => {
    expect(isAppAllowed(SLACK, BLOCK_SLACK)).toBe(false);
    expect(isAppAllowed(SLACK, BLOCK_MAIL)).toBe(true);
    expect(isAppAllowed(SLACK, { mode: "blocklist", bundleIds: [] })).toBe(true);
  });
  it("fails closed on an unidentifiable app, in BOTH modes", () => {
    for (const id of ["", "   "]) {
      expect(isAppAllowed(id, ALLOW_SLACK), id).toBe(false);
      expect(isAppAllowed(id, BLOCK_MAIL), id).toBe(false);
    }
  });
  it("PROBE_FILTER is an empty allowlist: the addon refuses every app with it", () => {
    expect(PROBE_FILTER).toEqual({ mode: "allowlist", bundleIds: [] });
  });

  it("PROBE_FILTER is frozen: neither the object nor its bundleIds array can be mutated at runtime, and bundleIds has no .push at compile time", () => {
    expect(Object.isFrozen(PROBE_FILTER)).toBe(true);
    expect(Object.isFrozen(PROBE_FILTER.bundleIds)).toBe(true);
    // @ts-expect-error bundleIds is `readonly string[]`: push does not exist
    // on the type (tsc fails this test file if that stops being a type
    // error). vitest doesn't type-check, so the call still runs at runtime,
    // where Object.freeze must reject it even with the compile-time guard bypassed.
    expect(() => PROBE_FILTER.bundleIds.push("com.evil.app")).toThrow(TypeError);
    expect(() => { (PROBE_FILTER as { mode: string }).mode = "blocklist"; }).toThrow(TypeError);
  });
});

describe("AxContextReader.read — mandatory filter, two-stage gate", () => {
  it("calls the addon twice: an empty allowlist first, then the EXACT id the probe reported", () => {
    const fake = makeFakeNative(okResult());
    // The user typed the id with the wrong case; the addon compares
    // case-sensitively, so stage 2 must get the addon's own spelling back.
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK_UPPER);
    expect(r.ok).toBe(true);
    expect(fake.calls.map((c) => c.bundleIdFilter)).toEqual([
      { mode: "allowlist", bundleIds: [] },
      { mode: "allowlist", bundleIds: [SLACK] },
    ]);
  });

  it("the probe harvests nothing: its levels are never reported, even if the addon returns some", () => {
    const fake = makeFakeNative(okResult(), true, { levels: [lvl(0, 9999, ["testo raccolto per errore"])], bundleId: "com.apple.mail" });
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: "com.apple.mail", levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses an app outside the allowlist WITHOUT a second call", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_MAIL);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: SLACK, levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
  });

  it("blocklist: a listed id is refused even with a different case; an unlisted one is read", () => {
    const blocked = makeFakeNative(okResult());
    expect(new AxContextReader({ native: blocked.native }).read(BLOCK_SLACK).ok).toBe(false);
    expect(blocked.calls).toHaveLength(1);
    const allowed = makeFakeNative(okResult());
    expect(new AxContextReader({ native: allowed.native }).read(BLOCK_MAIL).ok).toBe(true);
    expect(allowed.calls).toHaveLength(2);
    // The caller's blocklist filter is never itself forwarded to the addon:
    // what the addon sees is always the synthesized allowlist shape (empty,
    // then the exact id) — same guarantee the allowlist case asserts above.
    expect(allowed.calls.map((c) => c.bundleIdFilter)).toEqual([
      { mode: "allowlist", bundleIds: [] },
      { mode: "allowlist", bundleIds: [SLACK] },
    ]);
  });

  it("fails closed when the probe reports an empty bundleId, in both modes", () => {
    for (const filter of [ALLOW_SLACK, BLOCK_MAIL]) {
      const fake = makeFakeNative(okResult(), true, { bundleId: "" });
      const r = new AxContextReader({ native: fake.native }).read(filter);
      expect(r.ok === false && r.reason, filter.mode).toBe("app-not-allowed");
      expect(fake.calls, filter.mode).toHaveLength(1);
    }
  });

  it("fails closed and logs an anomaly when the probe SUCCEEDS despite the empty allowlist", () => {
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(okResult(), true, { ok: true, reason: undefined, levels: okResult().levels, chosenLevel: 2 });
    const r = new AxContextReader({ native: fake.native, logger }).read(ALLOW_SLACK);
    expect(r).toEqual({ ok: false, reason: "app-not-allowed", pid: 4242, bundleId: SLACK, levelSummary: [] });
    expect(fake.calls).toHaveLength(1);
    expect(seen.join(" ")).toContain("anomaly");
    assertNoLeak(seen, CASES[0]!);
  });

  it("logs the probe's own ok flag on a stage-1 timeout, so an anomaly masked by the timeout stays visible", () => {
    // ax-context-reader.ts checks probeMs > timeoutMs BEFORE checking
    // probe.ok, so a probe that both blew its budget AND wrongly said
    // ok:true (the same anomaly as the test above) is reported as a plain
    // "timeout" — without this field the disagreement between addon and
    // wrapper on the gate would never be logged. Neither `reason` changes
    // (both branches already fail closed): only the added diagnostic field
    // is new.
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(okResult(), true, { ok: true, reason: undefined, levels: okResult().levels, chosenLevel: 2 });
    const clock = [0, 501];
    const r = new AxContextReader({ native: fake.native, logger, now: () => clock.shift() ?? 501 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
    expect(seen.join(" ")).toContain('"probeOk":true');
    assertNoLeak(seen, CASES[0]!);
  });

  it("propagates a probe failure that is not app-not-allowed, without a second call", () => {
    for (const reason of ["no-element", "ax-error", "budget-exceeded"] as const) {
      const fake = makeFakeNative(okResult(), true, { reason });
      const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
      expect(r.ok === false && r.reason, reason).toBe(reason);
      expect(fake.calls, reason).toHaveLength(1);
    }
  });

  it("times out on the probe alone, without harvesting", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 501, 501, 501];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 501 }).read(ALLOW_SLACK);
    expect(r.ok === false && r.reason).toBe("timeout");
    expect(fake.calls).toHaveLength(1);
  });

  it("distinguishes stage 1 from stage 2 by the filter's SHAPE (empty allowlist), not by call parity: a refused read followed by an allowed read on the SAME double must succeed", () => {
    // This is the case the parity-based double got wrong: two consecutive
    // read()s on one double, first refused, second permitted. Under
    // call-count parity, the second read's stage 1 lands on an even call and
    // the double hands it `result` (a full harvest) instead of the forced
    // probe refusal — the wrapper then hits the "probe.ok" anomaly branch and
    // refuses even though the filter allows the app.
    const fake = makeFakeNative(okResult()); // bundleId is SLACK
    const refused = new AxContextReader({ native: fake.native }).read(ALLOW_MAIL);
    expect(refused.ok).toBe(false);
    const allowed = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(allowed.ok).toBe(true);
  });

  it("logs the filter as mode + size, never as the list of ids", () => {
    const { logger, seen } = makeSpyLogger();
    new AxContextReader({ native: makeFakeNative(okResult()).native, logger }).read({
      mode: "allowlist", bundleIds: [SLACK, "com.apple.mail", "com.brave.Browser"],
    });
    const all = seen.join(" ");
    expect(all).toContain('"filterMode":"allowlist"');
    expect(all).toContain('"filterSize":3');
    expect(all).not.toContain("com.apple.mail");
    expect(all).not.toContain("com.brave.Browser");
  });

  it("reports probeMs in the log meta of a refusal too (timings are null there)", () => {
    const { logger, seen } = makeSpyLogger();
    const clock = [0, 12, 12, 12];
    new AxContextReader({ native: makeFakeNative(okResult()).native, logger, now: () => clock.shift() ?? 12 }).read(ALLOW_MAIL);
    expect(seen.join(" ")).toContain('"probeMs":12');
  });
});

// normalizeFragments itself (the ⋄/newline splitter) is exercised end-to-end
// above (e.g. "returns the chosen level's fragments, normalized") and unit
// tested at its source in conversation-parser.test.ts; ax-context-reader.ts
// no longer keeps its own copy of it (final review, correction 6).

describe("splitByMarkerLines", () => {
  const p1 = "Buongiorno, le invio il preventivo aggiornato per la revisione dell'impianto elettrico del secondo piano.";
  const p2 = "Il totale è 4.850 euro IVA esclusa, con inizio lavori previsto entro tre settimane dall'accettazione.";
  const joined = `${p1} ${p2}`; // ≥ 120 chars: the AX tree lost the newline

  it("re-splits a long fragment along the newlines of the marker text when the lines cover it exactly", () => {
    expect(splitByMarkerLines([joined], `Re: Preventivo\n${p1}\n${p2}\nCordiali saluti`)).toEqual([p1, p2]);
  });
  it("leaves the fragment alone when the marker lines do not cover it exactly", () => {
    expect(splitByMarkerLines([joined], `${p1}\nqualcos'altro`)).toEqual([joined]);
  });
  it("leaves short fragments and fragments without marker text alone", () => {
    expect(splitByMarkerLines(["Marta: ciao"], "Marta:\nciao")).toEqual(["Marta: ciao"]);
    expect(splitByMarkerLines([joined], undefined)).toEqual([joined]);
  });

  describe("gluing lines shorter than SENTENCE_MIN to the preceding piece (correction 1)", () => {
    // Reproduces the Mail repro from the final review: a body whose last
    // paragraph is a short trailing question. Splitting naively along marker
    // lines turns it into its own fragment, which keepContentful then drops
    // (< SENTENCE_MIN, unattributed) — the interlocutor's actual question
    // disappears from lastMessage/gist. p3 alone is long enough to survive on
    // its own and must NOT be merged into what precedes it.
    const p1v =
      "Buongiorno, le confermo che il sopralluogo può slittare senza alcun inconveniente da parte nostra.";
    const s1 = "Grazie mille."; // < SENTENCE_MIN
    const s2 = "A presto."; // < SENTENCE_MIN
    const p3 =
      "Le va bene giovedì alle nove, oppure preferisce rimandare direttamente a venerdì pomeriggio?";
    const fragment = `${p1v} ${s1} ${s2} ${p3}`;
    const markerText = `Oggetto\n${p1v}\n${s1}\n${s2}\n${p3}\nCordiali saluti`;

    it("merges every consecutive short line into the piece being built, never emitting one alone", () => {
      expect(p1v.length).toBeGreaterThanOrEqual(SENTENCE_MIN);
      expect(s1.length).toBeLessThan(SENTENCE_MIN);
      expect(s2.length).toBeLessThan(SENTENCE_MIN);
      expect(p3.length).toBeGreaterThanOrEqual(SENTENCE_MIN);
      expect(fragment.length).toBeGreaterThanOrEqual(120);

      const out = splitByMarkerLines([fragment], markerText);
      expect(out).toEqual([`${p1v} ${s1} ${s2}`, p3]);
      // The trailing question is the crux of the repro: it must survive as
      // its own piece, long enough that keepContentful (SENTENCE_MIN) keeps it.
      expect(out).toContain(p3);
      expect(out.every((piece) => piece.length >= SENTENCE_MIN)).toBe(true);
    });

    it("reports how many pre-split fragments the marker lines touched (correction 8 diagnostics)", () => {
      const detailed = splitByMarkerLinesDetailed(["unrelated short", fragment], markerText);
      expect(detailed.touched).toBe(1);
      expect(detailed.fragments).toEqual(["unrelated short", `${p1v} ${s1} ${s2}`, p3]);
    });
  });
});

describe("findCoveringRun performance (correction 2)", () => {
  // Mirrors the reviewer's repro: N marker lines of ~60 chars (so N=300 is
  // ~18k chars, matching "833 ms measured"), plus 20 long fragments that
  // match NOTHING — the worst case, since a non-match used to force the full
  // O(n²) scan for every one of the 20 fragments. The old join-per-step
  // implementation took 833 ms at N=300 and 6.3 s at N=600 on the reviewer's
  // machine; the budgeted regression guard below (2 s for N=600, ~1000x
  // headroom over the optimized implementation's actual sub-10ms runtime) is
  // loose enough not to flake in CI while still failing hard under the old
  // implementation.
  function makeLines(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `Riga numero ${i} di contenuto non correlato al frammento cercato.`);
  }
  function makeNonMatchingFragments(n: number): string[] {
    return Array.from({ length: n }, (_, i) =>
      `Frammento lungo che non compare mai fra le righe del marker, indice ${i}, `.repeat(2));
  }

  it("stays fast at 300 and 600 marker lines with 20 non-matching long fragments", () => {
    const fragments = makeNonMatchingFragments(20);
    for (const n of [300, 600]) {
      const lines = makeLines(n);
      const markerText = lines.join("\n");
      const t0 = performance.now();
      const out = splitByMarkerLines(fragments, markerText);
      const ms = performance.now() - t0;
      expect(out).toEqual(fragments); // no match exists: every fragment passes through unchanged
      expect(ms).toBeLessThan(2000);
    }
  });

  it("still finds a match that starts deep into a large marker line list (the prefix skip doesn't miss it)", () => {
    const decoys = Array.from({ length: 400 }, (_, i) => `Riga decoy numero ${i} completamente estranea.`);
    const p1v = "Buongiorno, confermo con piacere il nostro appuntamento per la prossima settimana lavorativa.";
    const p2v = "Le farò sapere appena possibile eventuali variazioni di orario o di luogo dell'incontro.";
    const fragment = `${p1v} ${p2v}`;
    const lines = [...decoys, p1v, p2v, ...decoys];
    const out = splitByMarkerLines([fragment], lines.join("\n"));
    expect(out).toEqual([p1v, p2v]);
  });
});

describe("NativeLevel/LevelSummary truncated flag (correction 5)", () => {
  it("propagates truncated:true from a capped native level into levelSummary", () => {
    const fake = makeFakeNative(okResult({
      levels: [lvl(0, 17, ["Messaggio a Marta"], true), lvl(1, 22, ["Messaggio a Marta", "Invia"], false)],
      chosenLevel: 1,
    }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.levelSummary).toEqual([
      { depth: 0, chars: 17, n: 1, truncated: true },
      { depth: 1, chars: 22, n: 2, truncated: false },
    ]);
  });

  it("propagates truncated even on a failed read, via levelSummary", () => {
    const fake = makeFakeNative(okResult({ ok: false, reason: "budget-exceeded", levels: [lvl(0, 17, ["x"], true)] }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    expect(r.ok === false && r.levelSummary).toEqual([{ depth: 0, chars: 17, n: 1, truncated: true }]);
  });
});

describe("RawContext.markerText diagnostics", () => {
  it("is null when the addon returned no webkitMarkerText", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.markerText).toBeNull();
  });

  it("reports the marker text length and how many fragments it touched", () => {
    const p1 = "x".repeat(65);
    const p2 = "y".repeat(64);
    const long = `${p1} ${p2}`; // 130 chars: >= MARKER_SPLIT_MIN_CHARS (120)
    const markerText = `${p1}\n${p2}`; // joins with a single space to `long` exactly
    const fake = makeFakeNative(okResult({
      levels: [lvl(0, long.length, [long])],
      chosenLevel: 0,
      webkitMarkerText: markerText,
    }));
    const r = new AxContextReader({ native: fake.native }).read(ALLOW_SLACK);
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.fragments).toEqual([p1, p2]);
    expect(r.context.markerText).toEqual({ chars: markerText.length, fragmentsTouched: 1 });
  });
});

describe("parseFiniteNumber (correction 8 probe validation)", () => {
  it("returns the parsed number for valid input", () => {
    expect(parseFiniteNumber("3", "--delay")).toBe(3);
    expect(parseFiniteNumber("2500", "--budget")).toBe(2500);
    expect(parseFiniteNumber("-1.5", "--jump-ratio")).toBe(-1.5);
  });

  it("throws instead of silently returning NaN for non-numeric input", () => {
    expect(() => parseFiniteNumber("abc", "--delay")).toThrow(RangeError);
    expect(() => parseFiniteNumber("", "--budget")).toThrow(RangeError);
    expect(() => parseFiniteNumber("12x", "--jump-min")).toThrow(RangeError);
  });

  it("throws for Infinity, which Number() accepts but downstream guards cannot use", () => {
    expect(() => parseFiniteNumber("Infinity", "--budget")).toThrow(RangeError);
  });

  it("names the offending flag in the error message", () => {
    expect(() => parseFiniteNumber("nope", "--delay")).toThrow(/--delay/);
  });
});
