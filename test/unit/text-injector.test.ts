import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import {
  TextInjector,
  InjectorDeps,
  createDefaultTextInjector,
  PASTE_TIMEOUT_MS,
  CLIPBOARD_READ_TIMEOUT_MS,
  CLIPBOARD_WRITE_TIMEOUT_MS,
} from "../../src/main/text-injector.js";

// No test in this repo mocks electron yet. createDefaultTextInjector imports
// `clipboard` from it at module scope purely to WRITE the clipboard (both the
// transcript payload and, on the happy path, the restored prior value) —
// which this suite doesn't care about — it's here only so that importing
// text-injector.ts (and therefore constructing the real execFileP wired to
// the mocked node:child_process below) doesn't blow up under vitest's Node
// environment, which has no real electron runtime. Reading the prior
// clipboard no longer goes through `clipboard.readText()` at all (that was
// the synchronous main-thread AppKit call that could block for minutes on a
// stuck pasteboard promise) — it now shells out to `pbpaste` instead, see
// the node:child_process mock below.
vi.mock("electron", () => ({
  clipboard: {
    // Electron 44: both are async (W3C Clipboard API alignment).
    readText: vi.fn(async () => "prior-clipboard"),
    writeText: vi.fn(async () => undefined),
  },
}));

// Every other test in this file drives TextInjector through injected fake
// deps (see makeDeps below) and never touches real execFile, so mocking
// node:child_process here only affects the "createDefaultTextInjector"
// describe block further down — it pins the actual execFile calls that
// production code makes (both the `pbpaste` clipboard read and the
// `osascript` paste), which no test previously exercised.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: "", stderr: "" });
    },
  ),
}));

function makeDeps(overrides: Partial<InjectorDeps> = {}): InjectorDeps {
  const clip = { value: "prior-clipboard" };
  return {
    readClipboard: vi.fn(async () => clip.value),
    writeClipboard: vi.fn(async (v: string) => { clip.value = v; }),
    runPaste: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    logger: {
      info: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe("TextInjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the text to clipboard before invoking paste", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("Hello world.");
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, "Hello world.");
    expect(deps.runPaste).toHaveBeenCalledOnce();
  });

  it("restores prior clipboard contents after pasting", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("Hello.");
    // writeClipboard called twice: once with payload, once with restore
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, "Hello.");
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(2, "prior-clipboard");
  });

  it("returns success=true when paste completes", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    const result = await injector.inject("text");
    expect(result.pasted).toBe(true);
  });

  it("returns success=false and skips restore when paste fails", async () => {
    const deps = makeDeps({
      runPaste: vi.fn(async () => { throw new Error("osascript boom"); }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("text");
    expect(result.pasted).toBe(false);
    expect(result.reason).toContain("osascript boom");
    // payload still written
    expect(deps.writeClipboard).toHaveBeenCalledWith("text");
    // restore did NOT run on failure (so user can ⌘V manually later)
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("sleeps long enough between paste and restore to avoid a race", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("text");
    expect(deps.sleep).toHaveBeenCalledOnce();
    // 500ms — enough headroom for slow Electron/Chromium receivers to read
    // the clipboard before we restore the prior contents. Bumped from 150ms
    // after intermittent reports of prior-clipboard content being pasted.
    expect(deps.sleep).toHaveBeenCalledWith(500);
  });

  it("awaits the transcript write before invoking paste (Electron 44 async clipboard)", async () => {
    let resolveWrite!: () => void;
    const gate = new Promise<void>((r) => { resolveWrite = r; });
    const writeClipboard = vi.fn((_v: string) => gate);
    const deps = makeDeps({ writeClipboard });
    const resultPromise = new TextInjector(deps).inject("transcript");
    await vi.waitFor(() => expect(writeClipboard).toHaveBeenCalledWith("transcript"));
    // The write has not resolved yet: pasting now would paste the OLD clipboard.
    await Promise.resolve();
    expect(deps.runPaste).not.toHaveBeenCalled();
    resolveWrite();
    const result = await resultPromise;
    expect(deps.runPaste).toHaveBeenCalledOnce();
    expect(result.pasted).toBe(true);
  });

  it("returns pasted=false and does not paste when the transcript write rejects", async () => {
    const deps = makeDeps({
      writeClipboard: vi.fn(async () => { throw new Error("pasteboard unavailable"); }),
    });
    const result = await new TextInjector(deps).inject("text");
    expect(result.pasted).toBe(false);
    expect(result.reason).toContain("clipboard write failed");
    expect(result.reason).toContain("pasteboard unavailable");
    expect(deps.runPaste).not.toHaveBeenCalled();
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
  });

  it("still returns pasted=true and warns when restoring the prior clipboard rejects", async () => {
    const writeClipboard = vi
      .fn<[string], Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("restore boom"));
    const deps = makeDeps({ writeClipboard });
    const result = await new TextInjector(deps).inject("text");
    expect(result.pasted).toBe(true);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "text-injector: failed to restore prior clipboard",
      expect.objectContaining({ message: "restore boom" }),
    );
  });

  it("gives up on a transcript write that never settles after CLIPBOARD_WRITE_TIMEOUT_MS and does not paste", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({ writeClipboard: vi.fn(() => new Promise<void>(() => undefined)) });
    const resultPromise = new TextInjector(deps).inject("text");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_WRITE_TIMEOUT_MS + 10);
    const result = await resultPromise;
    expect(result.pasted).toBe(false);
    expect(result.reason).toContain("clipboard write timed out");
    expect(deps.runPaste).not.toHaveBeenCalled();
  });

  it("does not hang and still reports pasted=true when the restore write never settles", async () => {
    vi.useFakeTimers();
    const writeClipboard = vi
      .fn<[string], Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>(() => undefined));
    const deps = makeDeps({ writeClipboard });
    const resultPromise = new TextInjector(deps).inject("text");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_WRITE_TIMEOUT_MS + 10);
    const result = await resultPromise;
    expect(result.pasted).toBe(true);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "text-injector: failed to restore prior clipboard",
      expect.anything(),
    );
  });

  it("passes the abort signal through to runPaste", async () => {
    const controller = new AbortController();
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("text", controller.signal);
    expect(deps.runPaste).toHaveBeenCalledWith(controller.signal);
  });

  it("resolves to pasted=false without restoring clipboard when the signal aborts mid-paste", async () => {
    // Simulates the real execFile behavior: on abort, Node kills the child
    // and the promise rejects. runPaste never settles on its own here — only
    // the abort listener rejects it, same as the real osascript child would.
    const controller = new AbortController();
    const deps = makeDeps({
      runPaste: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
          }),
      ),
    });
    const injector = new TextInjector(deps);
    const resultPromise = injector.inject("transcript text", controller.signal);
    // The prior-clipboard read now happens off-thread (async) before the
    // paste is dispatched, so runPaste is no longer necessarily called
    // synchronously within this task — wait for it (and its abort listener)
    // to actually be registered before aborting.
    await vi.waitFor(() => expect(deps.runPaste).toHaveBeenCalled());
    controller.abort();
    const result = await resultPromise;

    expect(result.pasted).toBe(false);
    // clipboard must still hold the transcript — restore never ran
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(deps.writeClipboard).toHaveBeenCalledWith("transcript text");
    expect(deps.writeClipboard).not.toHaveBeenCalledWith("prior-clipboard");
  });

  it("returns pasted=false with reason and skips restore when the paste is killed by timeout", async () => {
    // Simulates execFile's real behavior when its `timeout` option fires:
    // the message never contains the word "killed" — that only shows up as
    // properties on the error object (killed: true, signal: "SIGTERM",
    // code: null). The message is just "Command failed: <cmd>\n" plus
    // whatever stderr osascript produced (here, none).
    const killedError = Object.assign(new Error("Command failed: osascript -e tell application \"System Events\" to keystroke \"v\" using command down\n"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    const deps = makeDeps({
      runPaste: vi.fn(async () => {
        throw killedError;
      }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("transcript text");

    expect(result.pasted).toBe(false);
    expect(result.reason).not.toContain("killed");
    expect(result.killed).toBe(true);
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBe(null);
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(deps.writeClipboard).not.toHaveBeenCalledWith("prior-clipboard");
  });

  it("returns pasted=false with AbortError diagnostics when the paste is killed by a cancel abort", async () => {
    // Simulates execFile's real behavior when the AbortSignal fires: name
    // "AbortError", code "ABORT_ERR", message "The operation was aborted" —
    // distinct from the timeout-kill shape above.
    const abortError = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    const deps = makeDeps({
      runPaste: vi.fn(async () => {
        throw abortError;
      }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("transcript text");

    expect(result.pasted).toBe(false);
    expect(result.errorName).toBe("AbortError");
    expect(result.code).toBe("ABORT_ERR");
    expect(result.killed).toBeUndefined();
  });

  // --- Off-thread, bounded clipboard read (the deadlock fix) ---------------
  //
  // Production symptom: readClipboard used to be `clipboard.readText()`, a
  // synchronous AppKit call on the main thread. When the general pasteboard
  // holds a promised item whose owner never delivers (observed: Xcode's
  // DeviceHub/CoreDevice clipboard sync with an iOS simulator booted), that
  // call can block the ENTIRE main thread for up to 120s — Node event loop,
  // IPC, NSEvent monitor, everything — leaving the overlay frozen on
  // "Pasting…" with no way to recover. The fix reads the prior clipboard out
  // of process via `pbpaste`, bounded by our OWN AbortController (not
  // execFile's `timeout` option — that only settles once the child actually
  // exits, and a child wedged in Mach IPC on an undelivered pasteboard
  // promise may never exit; `signal.abort()` on a still-alive child settles
  // the promise immediately instead). If the read doesn't answer within
  // CLIPBOARD_READ_TIMEOUT_MS, we give up on it and skip the restore rather
  // than risk restoring a wrong/stale value.

  it("calls the injected clipboard reader with a signal, bounded by its own timeout, and does not hang forever even if the reader never settles on its own", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const deps = makeDeps({
      readClipboard: vi.fn((signal?: AbortSignal) => {
        capturedSignal = signal;
        // Simulates a `pbpaste` child truly wedged in Mach IPC: it never
        // resolves or rejects on its own. Only our own abort() must be able
        // to settle this.
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })),
          );
        });
      }),
    });
    const injector = new TextInjector(deps);

    const resultPromise = injector.inject("text");
    // Flush pending microtasks (the logger.info await, etc.) under fake
    // timers so readClipboard has actually been invoked and its abort
    // listener registered, without yet advancing past the read timeout.
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.readClipboard).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(capturedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(CLIPBOARD_READ_TIMEOUT_MS);

    expect(capturedSignal?.aborted).toBe(true);

    const result = await resultPromise;
    expect(result.pasted).toBe(true);
  });

  it("still pastes and does NOT restore anything when the clipboard read aborts/times out", async () => {
    vi.useFakeTimers();
    const deps = makeDeps({
      readClipboard: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" })),
            );
          }),
      ),
    });
    const injector = new TextInjector(deps);

    const resultPromise = injector.inject("transcript text");
    await vi.advanceTimersByTimeAsync(CLIPBOARD_READ_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result.pasted).toBe(true);
    // Only the payload write — restore must be skipped because we never
    // found out what the prior clipboard actually held.
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(deps.writeClipboard).toHaveBeenCalledWith("transcript text");
    expect(deps.runPaste).toHaveBeenCalledOnce();
  });

  // Note: a third test asserting inject() "resolves, doesn't hang" on abort
  // used to live here. It's dropped — both tests above already `await
  // resultPromise` to completion without a catch/timeout escape hatch, so
  // they already prove resolution; a dedicated test for that added nothing
  // beyond what #10/#11 already pin.

  it("logs read-failure diagnostics (errorName/code/killed/signal) when the clipboard read fails", async () => {
    // Item 3: the catch around readClipboard used to swallow the error
    // completely, so a production log could never distinguish "our own
    // CLIPBOARD_READ_TIMEOUT_MS fired" from "pbpaste exited non-zero" from
    // "ENOENT". Pin that the same diagnostic shape lifted off paste errors
    // (see InjectResult) is also logged here.
    const deps = makeDeps({
      readClipboard: vi.fn(async () => {
        throw Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
          code: "ABORT_ERR",
        });
      }),
    });
    const injector = new TextInjector(deps);
    await injector.inject("text");

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/clipboard/i),
      expect.objectContaining({ errorName: "AbortError", code: "ABORT_ERR" }),
    );
  });

  it('restores a legitimately empty prior clipboard ("" is restorable, unlike null)', async () => {
    // This is the exact behaviour the `string | null` split on `prior`
    // exists to protect: an empty clipboard is a valid, restorable value,
    // distinct from "we couldn't determine the value" (null). Nothing
    // previously pinned it.
    const deps = makeDeps({ readClipboard: vi.fn(async () => "") });
    const injector = new TextInjector(deps);
    await injector.inject("Hello.");

    expect(deps.writeClipboard).toHaveBeenNthCalledWith(1, "Hello.");
    expect(deps.writeClipboard).toHaveBeenNthCalledWith(2, "");
    expect(deps.writeClipboard).toHaveBeenCalledTimes(2);
  });

  it("skips restore (but still pastes) when the clipboard read rejects for a non-abort reason", async () => {
    // Distinct from the abort/timeout path covered above: this is an
    // ordinary read failure with no AbortError shape at all (ENOENT,
    // non-zero exit, maxBuffer exceeded, RTF sniff rejection, ...). Only the
    // abort path was previously covered, three times over.
    const deps = makeDeps({
      readClipboard: vi.fn(async () => {
        throw Object.assign(new Error("Command failed: pbpaste\n"), { code: 1 });
      }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("transcript text");

    expect(result.pasted).toBe(true);
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(deps.writeClipboard).toHaveBeenCalledWith("transcript text");
  });

  it("logs immediately before and after reading the prior clipboard", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("text");

    const infoCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    const beforeIdx = infoCalls.findIndex((msg: string) => /clipboard/i.test(msg) && /read/i.test(msg));
    expect(beforeIdx).toBeGreaterThanOrEqual(0);
    const afterIdx = infoCalls.findIndex(
      (msg: string, i: number) => i > beforeIdx && /clipboard/i.test(msg) && /read/i.test(msg),
    );
    expect(afterIdx).toBeGreaterThan(beforeIdx);
  });
});

describe("createDefaultTextInjector", () => {
  beforeEach(async () => {
    vi.mocked(execFile).mockClear();
    const { clipboard } = await import("electron");
    vi.mocked(clipboard.writeText).mockClear();
    vi.mocked(clipboard.readText).mockClear();
  });

  it("calls execFile with the real osascript keystroke script and the paste timeout/signal", async () => {
    // Every test above mocks runPaste, so none of them would have noticed
    // if the `timeout:` option were ever deleted from the real
    // implementation. This test drives the actual factory function and
    // asserts against the mocked node:child_process execFile directly, so
    // it fails if that option (or the script text, or the signal wiring)
    // regresses.
    const logger = { info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined) };
    const injector = createDefaultTextInjector(logger);
    const controller = new AbortController();

    await injector.inject("hello", controller.signal);

    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-e", 'tell application "System Events" to keystroke "v" using command down'],
      expect.objectContaining({ timeout: PASTE_TIMEOUT_MS, signal: controller.signal }),
      expect.any(Function),
    );
  });

  it("reads the prior clipboard via pbpaste instead of the synchronous clipboard.readText()", async () => {
    // clipboard.readText() is the AppKit call that can block the whole main
    // thread for up to 120s on a stuck pasteboard promise (see production
    // logs). The default injector must never call it.
    const { clipboard } = await import("electron");
    const logger = { info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined) };
    const injector = createDefaultTextInjector(logger);

    await injector.inject("hello");

    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/pbpaste",
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it("pins LC_ALL=en_US.UTF-8 and a 32MB maxBuffer on the pbpaste execFile call", async () => {
    // Item 1 + item 4 regression guard, following the same pattern as the
    // osascript `timeout:` test above (drives the real factory function
    // against the mocked node:child_process execFile so option deletion is
    // caught). (1) pbpaste's output encoding comes from locale env vars —
    // without LC_ALL pinned to a UTF-8 locale it can silently emit MacRoman,
    // which Node then mis-decodes as UTF-8 with no error (accented
    // characters turn to mojibake). LC_ALL specifically, not LANG, because
    // LC_ALL always wins. (2) execFile's default maxBuffer is 1MB; without
    // raising it, a clipboard over that size rejects and the restore is
    // silently skipped.
    const logger = { info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined) };
    const injector = createDefaultTextInjector(logger);

    await injector.inject("hello");

    expect(execFile).toHaveBeenCalledWith(
      "/usr/bin/pbpaste",
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: "en_US.UTF-8" }),
        maxBuffer: 32 * 1024 * 1024,
      }),
      expect.any(Function),
    );
  });

  it("rejects the read (and skips restore) when pbpaste returns RTF markup instead of plain text", async () => {
    // Item 2: against a genuinely RTF-only pasteboard, `man pbpaste` says
    // `-Prefer txt` does NOT guarantee plain text back — it falls back to
    // whatever format IS available, so it still returns the raw RTF source.
    // Restoring that verbatim would leave the user's clipboard holding
    // literal "{\rtf1..." markup instead of the rich content they copied.
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args[3] as (err: unknown, result: { stdout: string; stderr: string }) => void;
      callback(null, { stdout: "{\\rtf1\\ansi\\ansicpg1252 Hello}", stderr: "" });
    }) as unknown as typeof execFile);
    const { clipboard } = await import("electron");
    const logger = { info: vi.fn(async () => undefined), warn: vi.fn(async () => undefined) };
    const injector = createDefaultTextInjector(logger);

    await injector.inject("hello");

    // Only the transcript payload should have been written — the RTF source
    // must never be written back as if it were plain text.
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
  });
});
