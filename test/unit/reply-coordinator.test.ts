import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ReplyCoordinator, hasExplicitProposal, isAlternativeGrounded, FLASH_TEXT, TAIL_BUDGET_CHARS, TOTAL_TIMEOUT_MS,
  SUGGEST_TTL_MS, VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR, ERROR_PILL_MS,
  type ReplyCoordinatorDeps, type ReplyPrefsSnapshot,
} from "../../src/main/reply-coordinator.js";
import { MIN_KEPT, type FilterInput, type FilterOutput, type FilterVariant } from "../../src/main/utils/variant-filter.js";
import type { ReadContextResult } from "../../src/main/ax-context-reader.js";
import type { ParseInput, ParseResult } from "../../src/main/utils/conversation-parser.js";
import type { ClassifyResult } from "../../src/main/reply-classifier.js";
import type { GenerateInput, GenerateResult } from "../../src/main/reply-generator.js";
import type { ReplyServerState, SuggestionPayload } from "../../src/shared/reply-types.js";
import { CASES, leaksScreenText } from "../fixtures/conversations/spike-corpus.js";
import { CLASSIFIER_CASES } from "../fixtures/conversations/classifier-corpus.js";

const SLACK = "com.tinyspeck.slackmacgap";

const CONTEXT = {
  pid: 4242, bundleId: SLACK, editableFound: true, editableIsFocused: true, chosenLevel: 2,
  levelSummary: [{ depth: 2, chars: 3748, n: 4, truncated: false }],
  fragments: ["Marta: la review la fai tu o la giro a Paolo?"],
  markerText: null,
  timings: { elementAtPositionMs: 31, collectMs: 23, totalMs: 60, probeMs: 12, wrapperMs: 75 },
};
const READ_OK: ReadContextResult = { ok: true, context: CONTEXT };
const readFail = (reason: "no-editable" | "budget-exceeded" | "timeout" | "app-not-allowed" | "not-trusted", bundleId = SLACK): ReadContextResult =>
  ({ ok: false, reason, pid: 4242, bundleId, levelSummary: [] });

const CONVERSATION: ParseResult = {
  kind: "conversation",
  turns: [{ speaker: "Marta", role: "counterpart", text: "la review la fai tu o la giro a Paolo?" }],
  counterpart: "Marta",
  transcript: "INTERLOCUTORE (Marta): la review la fai tu o la giro a Paolo?",
  lastMessage: "la review la fai tu o la giro a Paolo?",
  gist: "Rispondi a Marta: la review la fai tu o la giro a Paolo?",
  languageGuess: "it",
  stats: { fragmentsIn: 1, fragmentsKept: 1, fragmentsDeduped: 1, turns: 1, speakers: 1, unattributedDropped: 0, transcriptChars: 60 },
};

const CLASSIFIED: ClassifyResult = {
  ok: true,
  classification: { answerable: true, kind: "alternative", alternatives: ["la fai tu", "la giro a Paolo"], language: "it" },
  durationMs: 210,
};

const THREE: FilterVariant[] = [
  { key: "first", label: "Scelgo: la fai tu", text: "La faccio io, la chiudo entro oggi pomeriggio." },
  { key: "second", label: "Scelgo: la giro a Paolo", text: "Meglio girarla a Paolo, io questa settimana non arrivo." },
  { key: "defer", label: "Rimando", text: "Fammi controllare l'agenda e ti dico entro stasera." },
];
const GENERATED: GenerateResult = { ok: true, variants: THREE, durationMs: 1400, completionTokens: 90 };

interface Over {
  prefs?: Partial<ReplyPrefsSnapshot>;
  serverState?: ReplyServerState;
  trusted?: boolean;
  frontmostPid?: number | (() => number);
  read?: ReadContextResult;
  parse?: ParseResult;
  classify?: ClassifyResult | Promise<ClassifyResult>;
  generate?: GenerateResult | Promise<GenerateResult>;
  kept?: FilterVariant[];
  dropped?: FilterOutput["dropped"];
  dictationBusy?: boolean;
  injectResult?: { pasted: boolean; reason?: string };
  preGate?: (lastMessage: string) => boolean;
  activateApp?: boolean;
  /** Deadline control: the promise returned for sleep(TOTAL_TIMEOUT_MS). */
  deadline?: Promise<void>;
}

function makeEnv(over: Over = {}) {
  const states: string[] = [];
  const flashes: string[] = [];
  const shown: SuggestionPayload[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const timers: Array<{ ms: number; cb: () => void; cancelled: boolean }> = [];
  const order: string[] = [];
  const seen: string[] = [];
  const logger = {
    info: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
    warn: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
    error: vi.fn(async (m: string, meta?: Record<string, unknown>) => { seen.push(JSON.stringify([m, meta])); }),
  };
  // Captured into a local before narrowing: `typeof over.frontmostPid ===
  // "function"` does not survive re-reading the property inside the nested
  // closure below (TS widens property narrowing across closure boundaries),
  // only narrowing on a local `const` does.
  const frontmostPidOverride = over.frontmostPid;
  const front = typeof frontmostPidOverride === "function" ? frontmostPidOverride : () => frontmostPidOverride ?? 4242;
  const reader = {
    isTrusted: vi.fn(() => over.trusted ?? true),
    frontmostPid: vi.fn(front),
    activateApp: vi.fn(() => over.activateApp ?? true),
    read: vi.fn(() => { order.push("read"); return over.read ?? READ_OK; }),
  };
  const overlay = {
    show: vi.fn(() => { order.push("show"); }),
    hide: vi.fn(() => { order.push("hide"); }),
    sendState: vi.fn((s: string) => { states.push(s); }),
    sendFlash: vi.fn((t: string) => { flashes.push(t); order.push("flash"); }),
    showSuggestions: vi.fn((p: SuggestionPayload) => { shown.push(p); order.push("suggest"); }),
    resetSize: vi.fn(),
  };
  const shortcuts = {
    register: vi.fn((a: string) => { registered.push(a); return true; }),
    unregister: vi.fn((a: string) => { unregistered.push(a); }),
  };
  const server = {
    isReady: () => (over.serverState ?? "ready") === "ready",
    getState: () => over.serverState ?? "ready",
    recover: vi.fn(async () => true),
  };
  const inject = vi.fn(async () => { order.push("inject"); return over.injectResult ?? { pasted: true }; });
  const copyToClipboard = vi.fn((_t: string) => { order.push("copy"); });
  const classify = vi.fn(async () => over.classify ?? CLASSIFIED);
  // Typed parameter (unused by the implementation) so `.mock.calls[0][0]`
  // below type-checks as a `GenerateInput`, matching what the coordinator
  // actually calls this mock with, instead of the empty tuple TS would
  // otherwise infer from a zero-argument implementation.
  const generate = vi.fn(async (_input: GenerateInput) => over.generate ?? GENERATED);
  const filterVariants = vi.fn((input: FilterInput): FilterOutput => ({
    kept: over.kept ?? [...input.variants], dropped: over.dropped ?? [],
  }));
  const parse = vi.fn((_i: ParseInput): ParseResult => over.parse ?? CONVERSATION);
  const deps: ReplyCoordinatorDeps = {
    reader, overlay, shortcuts, server, inject, copyToClipboard, classify, generate, filterVariants, parse,
    loadPrefs: async () => ({ enabled: true, userDisplayName: "Danilo", appsMode: "allowlist", apps: [SLACK], ...over.prefs }),
    dictationBusy: () => over.dictationBusy ?? false,
    logger,
    onTrustRequired: vi.fn(),
    // Waits are injected: the flash delays, the 300 ms activation poll and the
    // 12 s deadline all go through here, so every test is deterministic.
    sleep: (ms: number) => (ms === TOTAL_TIMEOUT_MS ? (over.deadline ?? new Promise<void>(() => {})) : Promise.resolve()),
    setTimer: (cb: () => void, ms: number) => {
      const t = { cb, ms, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
    ...(over.preGate ? { preGate: over.preGate } : {}),
  };
  return { c: new ReplyCoordinator(deps), deps, reader, overlay, shortcuts, server, inject, copyToClipboard,
           classify, generate, filterVariants, parse, states, flashes, shown, registered, unregistered, timers, order, seen, logger };
}

/** The reply flow logs through `logger`; nothing it passes may contain screen
 *  text or generated text (Global Constraint 10). */
function assertNoLeak(seen: readonly string[], ax: string): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const line of seen) {
    expect(leaksScreenText(line, ax), line).toBe(false);
    expect(line.includes("ZQXV"), line).toBe(false);
  }
}

describe("ReplyCoordinator.onHotkey — guards (degradation L0/L2/L5)", () => {
  it("does nothing at all with the feature off: no read, no state, no flash", async () => {
    const e = makeEnv({ prefs: { enabled: false } });
    await e.c.onHotkey();
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.states).toEqual([]);
    expect(e.flashes).toEqual([]);
    expect(e.seen.join(" ")).toContain('"reason":"disabled"');
  });

  it("ignores the hotkey while dictation is running (mutual exclusion with the PTT)", async () => {
    const e = makeEnv({ dictationBusy: true });
    await e.c.onHotkey();
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"dictation-busy"');
  });

  it("ignores a second hotkey while it is already reading or thinking", async () => {
    let release: () => void = () => {};
    const pending = new Promise<ClassifyResult>((r) => { release = () => r(CLASSIFIED); });
    const e = makeEnv({ classify: pending });
    const first = e.c.onHotkey();
    await vi.waitFor(() => { expect(e.c.getState()).toBe("thinking"); });
    await e.c.onHotkey();
    expect(e.reader.read).toHaveBeenCalledTimes(1);
    expect(e.seen.join(" ")).toContain('"reason":"busy"');
    release();
    await first;
  });

  it("a second hotkey while suggesting closes the pill (toggle) and reads nothing new", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("idle");
    expect(e.reader.read).toHaveBeenCalledTimes(1);
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"hotkey-toggle"');
  });

  it("keeps the UI strings in English, saying Settings (the pill labels follow the conversation language instead)", () => {
    expect(FLASH_TEXT).toEqual({
      appNotAllowed: "App not enabled — add it in Settings",
      modelLoading: "Model loading…",
      modelFailed: "Model unavailable",
      noUserName: "Set your name in Settings",
      copyOnly: "Copied — paste with ⌘V",
    });
    const overlay = readFileSync(new URL("../../src/renderer/overlay.html", import.meta.url), "utf8");
    expect(overlay).toContain('reading: "Reading the conversation…"');
    expect(overlay).toContain('thinking: "Drafting replies…"');
    expect(overlay).toContain('nothing: "No suggestion"');
  });

  it("flashes 'Model loading…' while the server is starting or downloading, and never reads", async () => {
    for (const state of ["starting", "downloading"] as const) {
      const e = makeEnv({ serverState: state });
      await e.c.onHotkey();
      expect(e.flashes, state).toEqual([FLASH_TEXT.modelLoading]);
      expect(e.reader.read, state).not.toHaveBeenCalled();
      expect(e.states.at(-1), state).toBe("idle");
    }
  });

  it("flashes 'Model unavailable' when the server failed, and stays silent when it is off", async () => {
    const failed = makeEnv({ serverState: "failed" });
    await failed.c.onHotkey();
    expect(failed.flashes).toEqual([FLASH_TEXT.modelFailed]);
    const off = makeEnv({ serverState: "off" });
    await off.c.onHotkey();
    expect(off.flashes).toEqual([]);
    expect(off.seen.join(" ")).toContain('"reason":"server-off"');
  });

  it("flashes the missing-name message when userDisplayName is empty (the parser cannot assign roles)", async () => {
    const e = makeEnv({ prefs: { userDisplayName: "   " } });
    await e.c.onHotkey();
    expect(e.flashes).toEqual([FLASH_TEXT.noUserName]);
    expect(e.reader.read).not.toHaveBeenCalled();
  });

  it("calls onTrustRequired without a flash when Accessibility is not granted (L5)", async () => {
    const e = makeEnv({ trusted: false });
    await e.c.onHotkey();
    expect(e.deps.onTrustRequired).toHaveBeenCalledTimes(1);
    expect(e.flashes).toEqual([]);
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain("trust-required");
  });
});

describe("ReplyCoordinator.onHotkey — read stage", () => {
  it("passes the preferences' app filter to the reader, in the preference's mode", async () => {
    const e = makeEnv({ prefs: { appsMode: "blocklist", apps: ["com.apple.mail"] } });
    await e.c.onHotkey();
    expect(e.reader.read).toHaveBeenCalledWith({ mode: "blocklist", bundleIds: ["com.apple.mail"] });
  });

  // AxContextReader.isAppAllowed treats an EMPTY blocklist as universal
  // permission (unlike an empty allowlist, which refuses everyone). This is
  // the one production call site that builds a filter from a stored
  // preference, so an unset/emptied blocklist must never quietly become
  // "read any app anywhere" — it must fail closed instead.
  it("never reads with an empty blocklist: that preference is universal permission, not scoped", async () => {
    const e = makeEnv({ prefs: { appsMode: "blocklist", apps: [] } });
    await e.c.onHotkey();
    expect(e.reader.read).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"no-apps-configured"');
  });

  it("never shows the overlay BEFORE the addon read: the pill must not become the element under the cursor", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.order.indexOf("read")).toBeGreaterThanOrEqual(0);
    expect(e.order.indexOf("read")).toBeLessThan(e.order.indexOf("show"));
  });

  it("app-not-allowed: L2 flash, the bundle id is remembered, nothing is parsed", async () => {
    const e = makeEnv({ read: readFail("app-not-allowed", "com.apple.Notes") });
    await e.c.onHotkey();
    expect(e.flashes).toEqual([FLASH_TEXT.appNotAllowed]);
    expect(e.c.lastBlockedBundleId()).toBe("com.apple.Notes");
    expect(e.parse).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"app-not-allowed"');
  });

  it("abstains with the neutral 'nothing' state on every other read failure", async () => {
    for (const reason of ["no-editable", "budget-exceeded", "timeout", "not-trusted"] as const) {
      const e = makeEnv({ read: readFail(reason) });
      await e.c.onHotkey();
      expect(e.states, reason).toEqual(["reading", "nothing", "idle"]);
      expect(e.flashes, reason).toEqual([]);   // the reason would describe the screen
      expect(e.seen.join(" "), reason).toContain(`"reason":"${reason}"`);
      expect(e.parse, reason).not.toHaveBeenCalled();
    }
  });

  it("abstains with not-frontmost when the element under the mouse belongs to another app", async () => {
    const e = makeEnv({ frontmostPid: 999 });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"not-frontmost"');
    expect(e.parse).not.toHaveBeenCalled();
  });

  it("parses with the 2500-char tail budget and the userDisplayName of the preferences", async () => {
    const e = makeEnv({ prefs: { userDisplayName: "Danilo Franco" } });
    await e.c.onHotkey();
    expect(TAIL_BUDGET_CHARS).toBe(2_500);
    expect(e.parse).toHaveBeenCalledWith({
      fragments: CONTEXT.fragments, userDisplayName: "Danilo Franco", tailBudgetChars: 2_500,
    });
  });

  it("abstains on a parser abstention, with the reason as a code in the log", async () => {
    const e = makeEnv({ parse: { kind: "abstain", reason: "last-turn-is-user", stats: CONVERSATION.stats } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "nothing", "idle"]);
    expect(e.classify).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"last-turn-is-user"');
  });
});

describe("ReplyCoordinator.onHotkey — model stages", () => {
  it("classifies with the parser's transcript, last message and counterpart", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.classify).toHaveBeenCalledWith({
      transcript: CONVERSATION.transcript, lastMessage: CONVERSATION.lastMessage, counterpart: CONVERSATION.counterpart,
    });
    expect(e.states.slice(0, 2)).toEqual(["reading", "thinking"]);
  });

  it("abstains without a pill when the classifier says not-answerable, and on invalid-classification", async () => {
    for (const reason of ["not-answerable", "invalid-classification"] as const) {
      const e = makeEnv({ classify: { ok: false, reason, durationMs: 180 } });
      await e.c.onHotkey();
      expect(e.generate, reason).not.toHaveBeenCalled();
      expect(e.shown, reason).toEqual([]);
      expect(e.states, reason).toEqual(["reading", "thinking", "nothing", "idle"]);
      expect(e.seen.join(" "), reason).toContain(`"reason":"${reason}"`);
    }
  });

  it("L4 on an llm-error: the error pill for 2 s and exactly one server recovery attempt", async () => {
    const e = makeEnv({ classify: { ok: false, reason: "llm-error", error: "reply LLM HTTP 503", durationMs: 40 } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "thinking", "error", "idle"]);
    expect(e.server.recover).toHaveBeenCalledTimes(1);
    expect(ERROR_PILL_MS).toBe(2_000);
    expect(e.seen.join(" ")).toContain("reply LLM HTTP 503");   // a code, not a body
  });

  it("hands the generator the positions of the classified kind, the names, the subject and the language", async () => {
    const e = makeEnv({ parse: { ...CONVERSATION, subject: "Sopralluogo" }, prefs: { userDisplayName: "Danilo" } });
    await e.c.onHotkey();
    const arg = e.generate.mock.calls[0]![0];
    expect(arg.positions.map((p) => p.key)).toEqual(["first", "second", "defer"]);
    expect(arg.subject).toBe("Sopralluogo");
    expect(arg.userDisplayName).toBe("Danilo");
    expect(arg.counterpart).toBe("Marta");
    expect(arg.language).toBe("it");
  });

  it("prefers the language MEASURED by parse() over the one DECLARED by the classifier when they disagree", async () => {
    const e = makeEnv({
      parse: { ...CONVERSATION, languageGuess: "en" },
      classify: { ok: true, classification: { answerable: true, kind: "generic", language: "it" }, durationMs: 90 },
    });
    await e.c.onHotkey();
    const genArg = e.generate.mock.calls[0]![0];
    expect(genArg.language).toBe("en");
    expect(genArg.positions[0]!.label).toBe("Accept");
    expect(e.filterVariants).toHaveBeenCalledWith(expect.objectContaining({ language: "en" }));
  });

  it("falls back to the classifier's language when the parser's measurement is inconclusive (other)", async () => {
    const e = makeEnv({
      parse: { ...CONVERSATION, languageGuess: "other" },
      classify: { ok: true, classification: { answerable: true, kind: "generic", language: "it" }, durationMs: 90 },
    });
    await e.c.onHotkey();
    expect(e.generate.mock.calls[0]![0].language).toBe("it");
  });

  it("stays with the classifier's \"other\" even when the parser measured a concrete language", async () => {
    const e = makeEnv({
      parse: { ...CONVERSATION, languageGuess: "en" },
      classify: { ok: true, classification: { answerable: true, kind: "generic", language: "other" }, durationMs: 90 },
    });
    await e.c.onHotkey();
    expect(e.generate.mock.calls[0]![0].language).toBe("other");
  });

  it("keeps the alternative set when both alternatives are grounded, even reworded", async () => {
    const e = makeEnv({
      parse: { ...CONVERSATION, lastMessage: "Possiamo vederci venerdì stessa ora o preferisci un altro giorno?" },
      classify: {
        ok: true,
        classification: { answerable: true, kind: "alternative", alternatives: ["venerdì", "un altro giorno"], language: "it" },
        durationMs: 90,
      },
    });
    await e.c.onHotkey();
    const genArg = e.generate.mock.calls[0]![0];
    expect(genArg.positions.map((p) => p.key)).toEqual(["first", "second", "defer"]);
    expect(genArg.positions[0]!.label).toBe("Scelgo: venerdì");
  });

  it("degrades to the generic set when the classifier's alternatives are not grounded in lastMessage", async () => {
    const e = makeEnv({
      classify: {
        ok: true,
        classification: { answerable: true, kind: "alternative", alternatives: ["sabato pomeriggio", "domenica sera"], language: "it" },
        durationMs: 90,
      },
    });
    await e.c.onHotkey();
    const genArg = e.generate.mock.calls[0]![0];
    expect(genArg.positions.map((p) => p.key)).toEqual(["accept", "decline", "defer"]);
    const log = e.seen.join(" ");
    expect(log).toContain('"kind":"generic"');
  });

  it("uses the generic set when the classifier returned kind generic", async () => {
    const e = makeEnv({ classify: { ok: true, classification: { answerable: true, kind: "generic", language: "it" }, durationMs: 90 } });
    await e.c.onHotkey();
    const arg = e.generate.mock.calls[0]![0];
    expect(arg.positions.map((p) => p.key)).toEqual(["accept", "decline", "defer"]);
  });

  it("L4 on a generator llm-error, with one recovery attempt", async () => {
    const e = makeEnv({ generate: { ok: false, reason: "llm-error", error: "reply LLM request failed: TimeoutError", durationMs: 10_000 } });
    await e.c.onHotkey();
    expect(e.states).toEqual(["reading", "thinking", "error", "idle"]);
    expect(e.server.recover).toHaveBeenCalledTimes(1);
    expect(e.shown).toEqual([]);
  });

  it("filters with the parser's context and abstains with too-few-variants below MIN_KEPT", async () => {
    const e = makeEnv({ kept: [THREE[0]!], dropped: [{ key: "second", rule: "signature" }, { key: "defer", rule: "length" }] });
    await e.c.onHotkey();
    expect(MIN_KEPT).toBe(2);
    expect(e.shown).toEqual([]);
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    const log = e.seen.join(" ");
    expect(log).toContain('"reason":"too-few-variants"');
    expect(log).toContain('"rule":"signature"');     // {key, rule} only
    expect(e.filterVariants).toHaveBeenCalledWith(expect.objectContaining({
      lastMessage: CONVERSATION.lastMessage, transcript: CONVERSATION.transcript,
      counterpart: "Marta", userDisplayName: "Danilo", language: "it",
    }));
  });

  it("shows three variants with the gist, numbered 1-3, and registers Command+1/2/3 plus Escape", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.shown).toEqual([{
      gist: CONVERSATION.gist,
      variants: [
        { id: 1, label: "Scelgo: la fai tu", text: THREE[0]!.text },
        { id: 2, label: "Scelgo: la giro a Paolo", text: THREE[1]!.text },
        { id: 3, label: "Rimando", text: THREE[2]!.text },
      ],
    }]);
    expect(e.registered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.c.getState()).toBe("suggesting");
    expect(e.states.at(-1)).toBe("thinking");   // showSuggestions owns the suggesting state
  });

  it("registers only as many Command+N as there are surviving variants", async () => {
    const e = makeEnv({ kept: [THREE[0]!, THREE[2]!] });
    await e.c.onHotkey();
    expect(e.shown[0]!.variants.map((v) => v.id)).toEqual([1, 2]);
    expect(e.registered).toEqual(["Command+1", "Command+2", ESCAPE_ACCELERATOR]);
  });

  it("keeps at most three variants even if the filter returned more", async () => {
    const e = makeEnv({ kept: [...THREE, { key: "extra", label: "Extra", text: "Una quarta variante che non deve arrivare alla pill." }] });
    await e.c.onHotkey();
    expect(e.shown[0]!.variants).toHaveLength(3);
  });

  it("abstains with timeout after TOTAL_TIMEOUT_MS and discards the late result", async () => {
    let expire: () => void = () => {};
    const deadline = new Promise<void>((r) => { expire = r; });
    let release: () => void = () => {};
    const slow = new Promise<GenerateResult>((r) => { release = () => r(GENERATED); });
    const e = makeEnv({ deadline, generate: slow });
    const run = e.c.onHotkey();
    expire();
    await run;
    expect(TOTAL_TIMEOUT_MS).toBe(12_000);
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"timeout"');
    release();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(e.shown).toEqual([]);   // the late generation must not raise a pill
  });
});

describe("ReplyCoordinator — pill lifecycle", () => {
  it("Escape dismisses: every shortcut is unregistered, the size is reset, the pill hides", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.c.dismiss("esc");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.overlay.resetSize).toHaveBeenCalled();
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.c.getState()).toBe("idle");
    expect(e.seen.join(" ")).toContain('"reason":"esc"');
  });

  it("arms a 20 s auto-close timer; hover restarts it; dismissing cancels it", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.timers.filter((t) => t.ms === SUGGEST_TTL_MS)).toHaveLength(1);
    expect(SUGGEST_TTL_MS).toBe(20_000);
    e.c.onHover();
    expect(e.timers[0]!.cancelled).toBe(true);
    expect(e.timers.filter((t) => t.ms === SUGGEST_TTL_MS)).toHaveLength(2);
    e.c.dismiss("click");
    expect(e.timers[1]!.cancelled).toBe(true);
  });

  it("the 20 s timer dismisses the pill on its own", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.timers[0]!.cb();
    expect(e.c.getState()).toBe("idle");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.seen.join(" ")).toContain('"reason":"timeout-ttl"');
  });

  it("a PTT arm while suggesting closes the pill and unregisters the temporary shortcuts", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.c.onDictationArm();
    expect(e.c.getState()).toBe("idle");
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.seen.join(" ")).toContain('"reason":"ptt-arm"');
  });

  it("a PTT arm during thinking aborts the run: no pill even when the model answers later", async () => {
    let release: () => void = () => {};
    const slow = new Promise<GenerateResult>((r) => { release = () => r(GENERATED); });
    const e = makeEnv({ generate: slow });
    const run = e.c.onHotkey();
    await vi.waitFor(() => { expect(e.c.getState()).toBe("thinking"); });
    e.c.onDictationArm();
    release();
    await run;
    expect(e.shown).toEqual([]);
    expect(e.c.getState()).toBe("idle");
  });

  // Same guard, one stage earlier: the classifier (not the generator) is
  // still pending when the PTT arms. Covers the epoch check right after the
  // classifier's raced() call, which the timeout test never reaches (it is
  // decided by Promise.race itself, not by that check).
  it("a PTT arm during the classifier aborts the run: no pill, and the generator is never even called", async () => {
    let release: () => void = () => {};
    const slow = new Promise<ClassifyResult>((r) => { release = () => r(CLASSIFIED); });
    const e = makeEnv({ classify: slow });
    const run = e.c.onHotkey();
    await vi.waitFor(() => { expect(e.c.getState()).toBe("thinking"); });
    e.c.onDictationArm();
    release();
    await run;
    // The generator raced() call has its own, already-covered epoch check
    // right after it: asserting only `shown` stays empty would still pass
    // even without the check right after the classifier, since that later
    // check would catch the staleness anyway. Asserting `generate` was never
    // called is what isolates the classifier-stage check specifically.
    expect(e.generate).not.toHaveBeenCalled();
    expect(e.shown).toEqual([]);
    expect(e.c.getState()).toBe("idle");
  });

  it("hover and dismiss are no-ops when nothing is suggesting", () => {
    const e = makeEnv();
    e.c.onHover();
    e.c.dismiss("click");
    expect(e.unregistered).toEqual([]);
    expect(e.overlay.hide).not.toHaveBeenCalled();
  });
});

describe("ReplyCoordinator.accept", () => {
  it("skips its own paste if dictation arms while still waiting for the target app (Minor 8.2)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    const p = e.c.accept(1); // runs synchronously up to `await waitForFrontmost`, then suspends
    expect(e.c.getState()).toBe("injecting");
    e.c.onDictationArm(); // fires while accept() is still suspended there
    await p;
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.copyToClipboard).not.toHaveBeenCalled(); // not even the degraded path — no paste at all
    // Round 2, Minor 3.2: the abort used to be a silent `return` — the log
    // is the only record that the two pastes cancelled each other out.
    expect(e.seen.join(" ")).toContain('"reason":"epoch-superseded"');
  });

  it("Command+2 pastes the second variant: unregister → injecting → activateApp → inject", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    await e.c.accept(2);
    expect(e.unregistered).toEqual([...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]);
    expect(e.reader.activateApp).toHaveBeenCalledWith(4242);
    expect(e.inject).toHaveBeenCalledWith(THREE[1]!.text);
    expect(e.copyToClipboard).not.toHaveBeenCalled();
    expect(e.states.slice(-2)).toEqual(["injecting", "idle"]);
    expect(e.order.indexOf("inject")).toBeGreaterThan(e.order.indexOf("suggest"));
    expect(e.c.getState()).toBe("idle");
    expect(e.seen.join(" ")).toContain('"result":"pasted"');
  });

  it("waits for the target app to come to the front before pasting (up to 300 ms)", async () => {
    // frontmostPid: the overlay stole the front on the click, then Slack returns.
    const answers = [4242, 777, 777, 4242];
    const e = makeEnv({ frontmostPid: () => answers.shift() ?? 4242 });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.inject).toHaveBeenCalledWith(THREE[0]!.text);
  });

  it("clipboard-only with the copy flash when the app never comes to the front (L3)", async () => {
    // 4242 for the initial frontmost check, then the overlay owns the front.
    let n = 0;
    const e = makeEnv({ frontmostPid: () => (n++ === 0 ? 4242 : 777), activateApp: false });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.copyToClipboard).toHaveBeenCalledWith(THREE[0]!.text);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);
    expect(e.seen.join(" ")).toContain('"reason":"activate-failed"');
  });

  it("clipboard-only when editableIsFocused was false: the ⌘V would land in an unverified field", async () => {
    const e = makeEnv({ read: { ok: true, context: { ...CONTEXT, editableIsFocused: false } } });
    await e.c.onHotkey();
    await e.c.accept(3);
    expect(e.copyToClipboard).toHaveBeenCalledWith(THREE[2]!.text);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.reader.activateApp).not.toHaveBeenCalled();
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);
    expect(e.seen.join(" ")).toContain('"reason":"editable-not-focused"');
  });

  it("shows the copy flash when the injector reports pasted:false (Accessibility lost mid-session)", async () => {
    const e = makeEnv({ injectResult: { pasted: false, reason: "osascript exited 1" } });
    await e.c.onHotkey();
    await e.c.accept(1);
    expect(e.flashes).toEqual([FLASH_TEXT.copyOnly]);   // TextInjector already left the text in the clipboard
    expect(e.copyToClipboard).not.toHaveBeenCalled();
    expect(e.seen.join(" ")).toContain('"reason":"paste-failed"');
  });

  it("ignores an unknown id and a choose that arrives when nothing is suggesting", async () => {
    const e = makeEnv();
    await e.c.accept(1);
    expect(e.inject).not.toHaveBeenCalled();
    await e.c.onHotkey();
    await e.c.accept(7);
    await e.c.accept(0);
    expect(e.inject).not.toHaveBeenCalled();
    expect(e.c.getState()).toBe("suggesting");
    expect(e.seen.join(" ")).toContain('"reason":"unknown-variant"');
  });

  it("a second accept after the first is ignored (the shortcuts are already gone)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    await e.c.accept(1);
    await e.c.accept(2);
    expect(e.inject).toHaveBeenCalledTimes(1);
  });
});

// `reader.read` and `reader.activateApp`/`frontmostPid` call the native
// addon (ax_context.node): an N-API throw is plausible. Without a
// try/catch, a throw here would leave isBusy() permanently true — every
// later hotkey answered "busy" forever, and the pill parked on `thinking`
// with no way to dismiss() it (that requires state "suggesting"). Only
// restarting the app would recover. The assertion that actually proves the
// feature isn't dead is that a LATER hotkey still works.
describe("ReplyCoordinator — native addon throws (recovery)", () => {
  it("recovers when reader.read throws mid-pipeline", async () => {
    const e = makeEnv();
    e.reader.read.mockImplementationOnce(() => { throw new Error("N-API crash: 0x00 at /Users/danilo/secret/path"); });
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("idle");
    expect(e.c.isBusy()).toBe(false);
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.seen.join(" ")).not.toContain("secret/path");
    expect(e.seen.join(" ")).toContain('"reason":"exception"');

    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
  });

  it("recovers when parse throws mid-pipeline", async () => {
    const e = makeEnv();
    e.parse.mockImplementationOnce(() => { throw new Error("unexpected shape"); });
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("idle");
    expect(e.c.isBusy()).toBe(false);
    expect(e.overlay.hide).toHaveBeenCalled();

    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
  });

  it("recovers when classify rejects (not the modeled llm-error, an actual throw)", async () => {
    const e = makeEnv();
    e.classify.mockImplementationOnce(() => Promise.reject(new Error("socket hang up somewhere sensitive")));
    await e.c.onHotkey();
    expect(e.c.getState()).toBe("idle");
    expect(e.c.isBusy()).toBe(false);
    expect(e.overlay.hide).toHaveBeenCalled();
    expect(e.seen.join(" ")).not.toContain("sensitive");

    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
  });

  it("recovers when the native addon throws during accept (activateApp)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    e.reader.activateApp.mockImplementationOnce(() => { throw new Error("N-API crash"); });
    await e.c.accept(1);
    expect(e.c.getState()).toBe("idle");
    expect(e.c.isBusy()).toBe(false);
    expect(e.overlay.hide).toHaveBeenCalled();

    await e.c.onHotkey();
    expect(e.c.getState()).toBe("suggesting");
  });
});

describe("ReplyCoordinator — privacy (Global Constraint 10)", () => {
  it("logs codes, counts and timings only: never fragments, transcript, gist, names or variant text", async () => {
    const slack = CASES[0]!;   // slack-decisione
    const sentinel = (k: string, n: string): FilterVariant => ({ key: k, label: n, text: `ZQXV-VARIANT-TEXT ${n}` });
    const e = makeEnv({
      read: { ok: true, context: { ...CONTEXT, fragments: slack.ax.split("⋄").map((s) => s.trim()) } },
      parse: { ...CONVERSATION, transcript: `INTERLOCUTORE (Marta): ${slack.ax}`, lastMessage: slack.ax, gist: `Rispondi a Marta: ${slack.ax.slice(0, 60)}` },
      generate: { ok: true, variants: [sentinel("first", "uno"), sentinel("second", "due"), sentinel("defer", "tre")], durationMs: 1200, completionTokens: 88 },
    });
    await e.c.onHotkey();
    await e.c.accept(1);
    assertNoLeak(e.seen, slack.ax);
  });

  it("but the payload handed to the overlay DOES carry the text (so the test above discriminates)", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    expect(e.shown[0]!.variants[0]!.text).toBe(THREE[0]!.text);
    expect(e.shown[0]!.gist).toBe(CONVERSATION.gist);
  });

  it("reads the screen only on the hotkey: no timer, no listener, ever calls read again", async () => {
    const e = makeEnv();
    await e.c.onHotkey();
    for (const t of e.timers) t.cb();
    e.c.onHover();
    e.c.onDictationArm();
    expect(e.reader.read).toHaveBeenCalledTimes(1);
  });

  // Abstention is the NORMAL outcome of this feature — the overwhelming
  // majority of hotkeys never reach showSuggestions/accept at all. The two
  // tests above only exercise the (rarer) fully-successful path; this one
  // exercises abstain() itself, so the privacy guarantee has a test on the
  // path it actually needs to hold on most often.
  it("logs codes and counts only when the pipeline abstains (the normal outcome, not just the successful one)", async () => {
    const slack = CASES[0]!;
    const e = makeEnv({
      read: { ok: true, context: { ...CONTEXT, fragments: slack.ax.split("⋄").map((s) => s.trim()) } },
      parse: { kind: "abstain", reason: "last-turn-is-user", stats: CONVERSATION.stats },
    });
    await e.c.onHotkey();
    assertNoLeak(e.seen, slack.ax);
  });
});

describe("hasExplicitProposal (deterministic scope pre-gate)", () => {
  it("recognizes modals, explicit alternatives and offer words", () => {
    for (const m of [
      "la review la fai tu o la giro a Paolo?",
      "ti va di fare un punto domani mattina?",
      "riusciamo a spostare il sopralluogo a venerdì?",
      "puoi dare un'occhiata al lockfile?",
      "Would you prefer Tuesday afternoon or Wednesday morning?",
      "le invio il preventivo aggiornato, resto a disposizione.",
      "Shall we go ahead with that proposal?",
    ]) expect(hasExplicitProposal(m), m).toBe(true);
  });
  it("rejects wh-questions that ask for information only the user has", () => {
    for (const m of [
      "a che ora arrivi domani in ufficio?",
      "dove hai messo il file con le misure?",
      "quante volte a settimana vai in palestra?",
      "What is the current status of the migration on your side?",
      "mi ricorda il nome dell'elettricista?",
    ]) expect(hasExplicitProposal(m), m).toBe(false);
  });
  // Found missing from real usage: the Italian conditional IS the polite
  // request form ("potresti farmi la review?" reads as more natural, not
  // less, than "puoi farmi la review?" in a work chat), so it is the one
  // most likely to open a message asking for something. The present
  // indicative alone ("puoi", "riesci") was missing it entirely.
  it("recognizes the Italian conditional as a request, not only the present indicative", () => {
    for (const m of [
      "potresti farmi la review?",
      "mi faresti un favore?",
      "riusciresti entro venerdì?",
      "te la senti di occupartene?",
      "ce la fai per giovedì?",
    ]) expect(hasExplicitProposal(m), m).toBe(true);
  });
  // The five real messages from the user's own Slack conversation that
  // motivated this fix (gate-fix-report.md). Only the second is a request;
  // the others must stay "niente" — in particular the last one, which
  // states a preference ("sarei più su decisione 1") without asking for
  // anything, and must not be mistaken for a proposal just because it
  // discusses a decision.
  it("classifies the five real messages from the motivating conversation correctly", () => {
    expect(hasExplicitProposal("1 credo sto verificando su supabase una cosa.")).toBe(false);
    expect(hasExplicitProposal("nel frattempo mi faresti delle reviews.")).toBe(true);
    expect(hasExplicitProposal("grazie.")).toBe(false);
    expect(hasExplicitProposal("yesss.")).toBe(false);
    expect(hasExplicitProposal("Io sarei più su decisione 1 ma voglio fare degli accertamenti.")).toBe(false);
  });
  // Pins the side effect of adding the conditional forms above, measured
  // (not just asserted in a comment) against classifier-corpus.ts's eight
  // `info-*` cases — questions that ask for information only the user has,
  // and must be ruled OUT by this pre-gate before ever reaching the
  // classifier. Baseline before the conditional forms were added: 6/8
  // blocked (info-howmany leaks via "riesci", info-en-when via "could
  // you" — pre-existing, unrelated to this change). If this count drops,
  // the new words are letting an info-* case through and the addition
  // needs to be reconsidered, not the test.
  it("keeps blocking 6/8 'info-*' (information-only) cases after adding the conditional forms", () => {
    const info = CLASSIFIER_CASES.filter((c) => c.expected.answerable === false);
    expect(info).toHaveLength(8);
    const blocked = info.filter((c) => !hasExplicitProposal(c.lastMessage));
    expect(blocked).toHaveLength(6);
  });
});

describe("isAlternativeGrounded (Important 4)", () => {
  const MSG = "la review la fai tu o la giro a Paolo?";
  it("accepts an alternative copied verbatim from the message", () => {
    expect(isAlternativeGrounded("la fai tu", MSG)).toBe(true);
    expect(isAlternativeGrounded("la giro a Paolo", MSG)).toBe(true);
  });
  it("accepts a legitimate rewording that drops words but keeps the shared ones", () => {
    expect(isAlternativeGrounded("venerdì", "Possiamo vederci venerdì stessa ora o preferisci un altro giorno?")).toBe(true);
  });
  it("rejects an alternative invented out of thin air", () => {
    expect(isAlternativeGrounded("sabato pomeriggio", MSG)).toBe(false);
    expect(isAlternativeGrounded("domenica sera", MSG)).toBe(false);
  });
  it("rejects an empty string (no words to ground)", () => {
    expect(isAlternativeGrounded("", MSG)).toBe(false);
  });
  it("is accent- and apostrophe-insensitive, like the rest of the file's comparisons", () => {
    expect(isAlternativeGrounded("perche non domani", "Perché non ci vediamo domani?")).toBe(true);
  });

  describe("exact membership on numbers and proper nouns (round 2, Important 2)", () => {
    // Executed by the round-2 review: a wrong number/name scored WELL above
    // the 0.5 word-overlap threshold because the surrounding words carried
    // the score — the digit itself is invisible to \p{L}+, and a name is
    // just one word among several. Both need their own exact check.
    it("rejects a name swapped for the one the message actually said, despite high word overlap", () => {
      // "la giro a Marco" scores 0.67 against MSG (3 of 4 words shared).
      expect(isAlternativeGrounded("la giro a Marco", MSG)).toBe(false);
    });
    it("rejects a number swapped for the one the message actually said, despite full word overlap", () => {
      const msg = "confermi con lo sconto del 10%?";
      // "con lo sconto del 20%" scores 1.00 on words alone (%/digits are invisible to \p{L}+).
      expect(isAlternativeGrounded("con lo sconto del 20%", msg)).toBe(false);
    });
    // The opposite direction: a legitimate alternative that CONTAINS a real
    // number or name must not be punished for containing one.
    it("keeps a number the message actually states", () => {
      expect(isAlternativeGrounded("lo sconto del 10%", "confermi con lo sconto del 10%?")).toBe(true);
    });
    it("keeps a name the message actually states", () => {
      expect(isAlternativeGrounded("la giro a Paolo", MSG)).toBe(true);
    });
    // A model that merely RE-CASES a shared word (not a genuine invented
    // name) must not be punished: the proper-noun check compares
    // case/accent-insensitively, the same normalization as the rest of this
    // function, not a literal string match.
    it("does not treat a re-cased shared word as an invented name", () => {
      expect(isAlternativeGrounded("ci vediamo Giovedì", "ci vediamo giovedì mattina va bene?")).toBe(true);
    });
    // Sentence-initial capitalization says nothing about whether a word is a
    // name: the first token of the alternative itself is never checked.
    it("does not flag the alternative's own first word merely for being capitalized", () => {
      expect(isAlternativeGrounded("Confermo la prima opzione", "puoi confermare la prima opzione o preferisci l'altra?")).toBe(true);
    });
  });
});

describe("ReplyCoordinator — pre-gate wiring", () => {
  it("abstains with no-explicit-proposal BEFORE the classifier when the pre-gate is wired and says no", async () => {
    const e = makeEnv({ preGate: () => false });
    await e.c.onHotkey();
    expect(e.classify).not.toHaveBeenCalled();
    expect(e.states).toEqual(["reading", "thinking", "nothing", "idle"]);
    expect(e.seen.join(" ")).toContain('"reason":"no-explicit-proposal"');
  });
  it("classifies normally when the pre-gate is absent, even on a message it would reject", async () => {
    const e = makeEnv({ parse: { ...CONVERSATION, lastMessage: "a che ora arrivi domani?" } });
    await e.c.onHotkey();
    expect(e.classify).toHaveBeenCalledTimes(1);
  });
});
