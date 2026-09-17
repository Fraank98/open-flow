import { describe, it, expect, vi, beforeEach } from "vitest";
import { TextInjector, InjectorDeps } from "../../src/main/text-injector.js";

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
    // Simulates execFile's behavior when its `timeout` option fires: the
    // child is killed and the promise rejects.
    const deps = makeDeps({
      runPaste: vi.fn(async () => {
        throw new Error("Command failed: osascript ... (killed)");
      }),
    });
    const injector = new TextInjector(deps);
    const result = await injector.inject("transcript text");

    expect(result.pasted).toBe(false);
    expect(result.reason).toContain("killed");
    expect(deps.writeClipboard).toHaveBeenCalledTimes(1);
    expect(deps.writeClipboard).not.toHaveBeenCalledWith("prior-clipboard");
  });
});
