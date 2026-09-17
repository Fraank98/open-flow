import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { TextInjector, InjectorDeps, createDefaultTextInjector, PASTE_TIMEOUT_MS } from "../../src/main/text-injector.js";

// No test in this repo mocks electron yet. createDefaultTextInjector imports
// `clipboard` from it at module scope purely to read/restore the prior
// clipboard value, which this suite doesn't care about — it's here only so
// that importing text-injector.ts (and therefore constructing the real
// execFileP wired to the mocked node:child_process below) doesn't blow up
// under vitest's Node environment, which has no real electron runtime.
vi.mock("electron", () => ({
  clipboard: {
    readText: vi.fn(() => "prior-clipboard"),
    writeText: vi.fn(),
  },
}));

// Every other test in this file drives TextInjector through injected fake
// deps (see makeDeps below) and never touches real execFile, so mocking
// node:child_process here only affects the "createDefaultTextInjector"
// describe block further down — it pins the actual execFile call that
// production code makes, which no test previously exercised (deleting the
// `timeout:` key from createDefaultTextInjector still passed every test in
// this repo before this block was added).
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
    readClipboard: vi.fn(() => clip.value),
    writeClipboard: vi.fn((v: string) => { clip.value = v; }),
    runPaste: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("TextInjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});

describe("createDefaultTextInjector", () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear();
  });

  it("calls execFile with the real osascript keystroke script and the paste timeout/signal", async () => {
    // Every test above mocks runPaste, so none of them would have noticed
    // if the `timeout:` option were ever deleted from the real
    // implementation. This test drives the actual factory function and
    // asserts against the mocked node:child_process execFile directly, so
    // it fails if that option (or the script text, or the signal wiring)
    // regresses.
    const injector = createDefaultTextInjector();
    const controller = new AbortController();

    await injector.inject("hello", controller.signal);

    expect(execFile).toHaveBeenCalledWith(
      "osascript",
      ["-e", 'tell application "System Events" to keystroke "v" using command down'],
      expect.objectContaining({ timeout: PASTE_TIMEOUT_MS, signal: controller.signal }),
      expect.any(Function),
    );
  });
});
