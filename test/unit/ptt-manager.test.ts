import { describe, it, expect, vi, afterEach } from "vitest";
import { PTTManager, NativePttState } from "../../src/main/ptt-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

type Cb = (state: NativePttState, detail?: string) => void;

/**
 * Fake ptt_monitor addon: lets a test drive the native callback directly
 * instead of loading the real .node (which needs Accessibility + a build).
 */
function makeFakeNative() {
  let cb: Cb | null = null;
  return {
    native: {
      start: (c: Cb) => {
        cb = c;
        return true;
      },
      stop: () => {},
      isTrusted: () => true,
      requestTrust: () => true,
    },
    fire: (state: NativePttState, detail?: string) => cb?.(state, detail),
  };
}

describe("PTTManager diagnostics", () => {
  it("forwards the native detail payload on rawEvent", () => {
    const fake = makeFakeNative();
    const ptt = new PTTManager({ minHoldMs: 150, native: fake.native });
    const seen: Array<[string, string | undefined]> = [];
    ptt.on("rawEvent", (state: string, detail?: string) => seen.push([state, detail]));
    ptt.start();

    fake.fire("DOWN", "flags=0x80120");
    fake.fire("CHORD", "keyCode=123 chars=<left> repeat=0 flags=0x80120");

    expect(seen).toEqual([
      ["DOWN", "flags=0x80120"],
      ["CHORD", "keyCode=123 chars=<left> repeat=0 flags=0x80120"],
    ]);
  });

  it("reports DESYNC without disturbing the PTT state machine", () => {
    vi.useFakeTimers();
    const fake = makeFakeNative();
    const ptt = new PTTManager({ minHoldMs: 150, native: fake.native });
    const raw: Array<[string, string | undefined]> = [];
    const started = vi.fn();
    const cancelled = vi.fn();
    ptt.on("rawEvent", (state: string, detail?: string) => raw.push([state, detail]));
    ptt.on("start", started);
    ptt.on("cancel", cancelled);
    ptt.start();

    fake.fire("DOWN", "flags=0x80120");
    // A dropped flagsChanged edge: the cached Option state disagrees with the
    // live one. Purely observational — it must not arm, start or cancel.
    fake.fire("DESYNC", "cached=0 actual=1 keyCode=8");
    vi.advanceTimersByTime(200);

    expect(raw).toContainEqual(["DESYNC", "cached=0 actual=1 keyCode=8"]);
    expect(started).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
