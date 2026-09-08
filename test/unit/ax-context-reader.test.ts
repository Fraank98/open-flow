import { describe, it, expect, vi } from "vitest";
import {
  AxContextReader,
  DEFAULT_READ_OPTIONS,
  parseFiniteNumber,
  splitByMarkerLines,
  splitByMarkerLinesDetailed,
  toLogMeta,
  type AxContextNative,
  type NativeContextResult,
  type NativeLevel,
  type ReadOptions,
} from "../../src/main/ax-context-reader.js";
import { SENTENCE_MIN } from "../../src/main/utils/conversation-parser.js";
import { CASES, axFragments, leaksScreenText, type ConversationCase } from "../fixtures/conversations/spike-corpus.js";

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
    expect(DEFAULT_READ_OPTIONS).toEqual({
      maxDepth: 8, maxTotalChars: 16_000, timeBudgetMs: 300, jumpRatio: 10, jumpMinChars: 400, textMarkers: false,
    });
    expect(fake.calls[0]).toEqual(DEFAULT_READ_OPTIONS);
  });

  it("does not enable textMarkers unless the caller opts in", () => {
    const fake = makeFakeNative(okResult());
    new AxContextReader({ native: fake.native }).read();
    expect(fake.calls[0]?.textMarkers).toBe(false);
    new AxContextReader({ native: fake.native }).read({ textMarkers: true });
    expect(fake.calls[1]?.textMarkers).toBe(true);
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
      { depth: 0, chars: 17, n: 1, truncated: false },
      { depth: 1, chars: 22, n: 2, truncated: false },
      { depth: 2, chars: 3748, n: 2, truncated: false },
    ]);
    expect(r.context.pid).toBe(4242);
    expect(r.context.editableIsFocused).toBe(true);
    expect(r.context.markerText).toBeNull();
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
    const fake = makeFakeNative(okResult({ levels: [lvl(0, 3, ["   ", "⋄"])], chosenLevel: 0 }));
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
        lvl(0, 17, ["Messaggio a Marta"]),
        lvl(7, slack.ax.length, axFragments(slack.ax)),
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
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
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
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
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
      levels: [lvl(7, slack.ax.length, axFragments(slack.ax))],
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
        lvl(0, 3, ["   ", "⋄"]),
        lvl(7, slack.ax.length, axFragments(slack.ax)),
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
    const r = new AxContextReader({ native: fake.native }).read();
    if (!r.ok) throw new Error(r.reason);
    expect(r.context.levelSummary).toEqual([
      { depth: 0, chars: 17, n: 1, truncated: true },
      { depth: 1, chars: 22, n: 2, truncated: false },
    ]);
  });

  it("propagates truncated even on a failed read, via levelSummary", () => {
    const fake = makeFakeNative(okResult({ ok: false, reason: "budget-exceeded", levels: [lvl(0, 17, ["x"], true)] }));
    const r = new AxContextReader({ native: fake.native }).read();
    expect(r.ok === false && r.levelSummary).toEqual([{ depth: 0, chars: 17, n: 1, truncated: true }]);
  });
});

describe("RawContext.markerText diagnostics", () => {
  it("is null when the addon returned no webkitMarkerText", () => {
    const fake = makeFakeNative(okResult());
    const r = new AxContextReader({ native: fake.native }).read();
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
    const r = new AxContextReader({ native: fake.native }).read();
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
