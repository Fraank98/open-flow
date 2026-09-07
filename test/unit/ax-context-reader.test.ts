import { describe, it, expect, vi } from "vitest";
import {
  AxContextReader,
  DEFAULT_READ_OPTIONS,
  normalizeNativeFragments,
  splitByMarkerLines,
  toLogMeta,
  type AxContextNative,
  type NativeContextResult,
  type ReadOptions,
} from "../../src/main/ax-context-reader.js";
import { CASES, axFragments, leaksScreenText, type ConversationCase } from "../fixtures/conversations/spike-corpus.js";

function okResult(over: Partial<NativeContextResult> = {}): NativeContextResult {
  return {
    ok: true,
    pid: 4242,
    bundleId: "com.tinyspeck.slackmacgap",
    editableFound: true,
    editableIsFocused: true,
    levels: [
      { depth: 0, chars: 17, fragments: ["Messaggio a Marta"] },
      { depth: 1, chars: 22, fragments: ["Messaggio a Marta", "Invia"] },
      { depth: 2, chars: 3748, fragments: ["Marta: ciao 09:12. ⋄ 09:12 ⋄ ciao", "Invia"] },
    ],
    chosenLevel: 2,
    axManualAccessibility: 0,
    timings: { elementAtPositionMs: 31, collectMs: 23, totalMs: 60 },
    ...over,
  };
}

function makeFakeNative(result: NativeContextResult, trusted = true) {
  const calls: ReadOptions[] = [];
  const native: AxContextNative = {
    readContextUnderCursor: (opts) => { calls.push(opts); return result; },
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
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r).toEqual({ ok: false, reason: "not-trusted", pid: -1, bundleId: "", levelSummary: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it("passes the spec budgets to the addon by default", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read();
    expect(DEFAULT_READ_OPTIONS).toEqual({ maxDepth: 8, maxTotalChars: 16_000, timeBudgetMs: 300, jumpRatio: 10, jumpMinChars: 400 });
    expect(fake.calls[0]).toEqual(DEFAULT_READ_OPTIONS);
  });

  it("forwards a bundleIdFilter untouched", () => {
    const fake = makeFakeNative(okResult());
    const filter = { mode: "allowlist" as const, bundleIds: ["com.apple.mail"] };
    new AxContextReader({ native: fake.native }).read({ bundleIdFilter: filter });
    expect(fake.calls[0]?.bundleIdFilter).toEqual(filter);
  });

  it("maps a failed native result to ok:false with the native reason and the level counts", () => {
    const fake = makeFakeNative(okResult({ ok: false, reason: "no-editable", editableFound: false, levels: [], chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-editable");
    expect(r.pid).toBe(4242);
    expect(r.bundleId).toBe("com.tinyspeck.slackmacgap");
  });

  it("uses 'ax-error' when a failed result carries no reason", () => {
    const fake = makeFakeNative(okResult({ ok: false }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok === false && r.reason).toBe("ax-error");
  });

  it("returns the chosen level's fragments, normalized (⋄ split, trimmed, deduped)", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read();
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.fragments).toEqual(["Marta: ciao 09:12.", "09:12", "ciao", "Invia"]);
    expect(r.context.chosenLevel).toBe(2);
    expect(r.context.levelSummary).toEqual([
      { depth: 0, chars: 17, n: 1 }, { depth: 1, chars: 22, n: 2 }, { depth: 2, chars: 3748, n: 2 },
    ]);
    expect(r.context.pid).toBe(4242);
    expect(r.context.editableIsFocused).toBe(true);
  });

  it("computes wrapperMs from the wrapper's own clock, alongside the native timings", () => {
    const fake = makeFakeNative(okResult());
    const clock = [100, 137];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 137 }).read();
    if (!r.ok) throw new Error(r.reason);
    // okResult()'s native timings are elementAtPositionMs:31, collectMs:23, totalMs:60;
    // wrapperMs must be the wrapper's own 137-100=37, not a copy of any native field.
    expect(r.context.timings).toEqual({ elementAtPositionMs: 31, collectMs: 23, totalMs: 60, wrapperMs: 37 });
  });

  it("falls back to the richest level when the addon found no jump", () => {
    const fake = makeFakeNative(okResult({ chosenLevel: -1 }));
    const r = new AxContextReader({ native: fake.native }).read();
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.chosenLevel).toBe(-1);
    expect(r.context.fragments[0]).toBe("Marta: ciao 09:12.");
  });

  it("returns no-text when the chosen level normalizes to nothing", () => {
    const fake = makeFakeNative(okResult({ levels: [{ depth: 0, chars: 3, fragments: ["   ", "⋄"] }], chosenLevel: 0 }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok === false && r.reason).toBe("no-text");
  });

  it("rejects as 'timeout' a call that took longer than timeoutMs (500 by default)", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 501];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 501 }).read();
    expect(r.ok === false && r.reason).toBe("timeout");
  });

  it("accepts a call that took exactly timeoutMs", () => {
    const fake = makeFakeNative(okResult());
    const clock = [0, 500];
    const r = new AxContextReader({ native: fake.native, now: () => clock.shift() ?? 500 }).read();
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
        { depth: 0, chars: 17, fragments: ["Messaggio a Marta"] },
        { depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) },
      ],
      chosenLevel: 1,
      webkitMarkerText: axFragments(mail.ax).join("\n"),
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read();
    expect(r.ok).toBe(true);
    assertNoLeak(seen, slack, mail);
  });

  it("non passa mai al logger testo letto dallo schermo (not-trusted)", () => {
    // Real corpus content sits in the native result to prove that even a
    // native mock loaded with content leaks nothing when isTrusted() gates
    // the call before the native reader is ever invoked.
    const result = okResult({
      levels: [{ depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) }],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result, false);
    const r = new AxContextReader({ native: fake.native, logger }).read();
    expect(r.ok === false && r.reason).toBe("not-trusted");
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (timeout)", () => {
    const result = okResult({
      levels: [{ depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) }],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const clock = [0, 501];
    const r = new AxContextReader({ native: fake.native, logger, now: () => clock.shift() ?? 501 }).read();
    expect(r.ok === false && r.reason).toBe("timeout");
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (nativo fallito)", () => {
    const result = okResult({
      ok: false,
      reason: "budget-exceeded",
      levels: [{ depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) }],
      chosenLevel: -1,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read();
    expect(r.ok === false && r.reason).toBe("budget-exceeded");
    assertNoLeak(seen, slack);
  });

  it("non passa mai al logger testo letto dallo schermo (no-text)", () => {
    // The chosen level (0) normalizes to nothing; a second, unchosen level
    // carries real corpus content, proving it never leaks via levelSummary.
    const result = okResult({
      levels: [
        { depth: 0, chars: 3, fragments: ["   ", "⋄"] },
        { depth: 7, chars: slack.ax.length, fragments: axFragments(slack.ax) },
      ],
      chosenLevel: 0,
    });
    const { logger, seen } = makeSpyLogger();
    const fake = makeFakeNative(result);
    const r = new AxContextReader({ native: fake.native, logger }).read();
    expect(r.ok === false && r.reason).toBe("no-text");
    assertNoLeak(seen, slack);
  });

  it("toLogMeta exposes counts, codes, bundleId and timings only", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read();
    const meta = toLogMeta(r);
    expect(Object.keys(meta).sort()).toEqual([
      "bundleId", "chosenLevel", "editableFound", "editableIsFocused", "fragments", "levels", "ok", "pid", "reason", "timings",
    ]);
    expect(meta.fragments).toBe(4); // a COUNT, never the strings
    expect(JSON.stringify(meta)).not.toContain("Marta");
  });
});

describe("normalizeNativeFragments", () => {
  it("splits on ⋄ and newlines, trims, collapses spaces, dedupes, keeps order", () => {
    expect(normalizeNativeFragments(["a ⋄ b\nc", " a ", "d  e"])).toEqual(["a", "b", "c", "d e"]);
  });
});

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
});
