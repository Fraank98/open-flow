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

  it("sleeps briefly between paste and restore", async () => {
    const deps = makeDeps();
    const injector = new TextInjector(deps);
    await injector.inject("text");
    expect(deps.sleep).toHaveBeenCalledOnce();
    expect(deps.sleep).toHaveBeenCalledWith(150);
  });
});
