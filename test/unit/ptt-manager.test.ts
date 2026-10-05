import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

type GestureEvent = "arm" | "start" | "stop" | "cancel" | "trustRequired" | "ready";
const GESTURE_EVENTS: GestureEvent[] = ["arm", "start", "stop", "cancel", "trustRequired", "ready"];

/** Fake native whose trust / install answers and calls the test controls. */
function makeControllableNative(opts: { trusted?: boolean; installs?: boolean } = {}) {
  let cb: Cb | null = null;
  const native = {
    start: vi.fn((c: Cb) => {
      cb = c;
      return opts.installs ?? true;
    }),
    stop: vi.fn(() => undefined),
    isTrusted: vi.fn(() => opts.trusted ?? true),
    requestTrust: vi.fn(() => true),
  };
  return { native, fire: (state: NativePttState) => cb?.(state) };
}

/** Records every gesture event in order. */
function record(ptt: PTTManager): GestureEvent[] {
  const events: GestureEvent[] = [];
  for (const name of GESTURE_EVENTS) ptt.on(name, () => events.push(name));
  return events;
}

describe("PTTManager gesture state machine", () => {
  const HOLD = 150;
  let fake: ReturnType<typeof makeControllableNative>;
  let ptt: PTTManager;
  let events: GestureEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    fake = makeControllableNative();
    ptt = new PTTManager({ minHoldMs: HOLD, native: fake.native });
    events = record(ptt);
    ptt.start();
    events.length = 0; // drop "ready"
  });

  it("DOWN arms immediately, starts after minHoldMs, and UP stops", () => {
    fake.fire("DOWN");
    expect(events).toEqual(["arm"]);

    vi.advanceTimersByTime(HOLD);
    expect(events).toEqual(["arm", "start"]);

    fake.fire("UP");
    expect(events).toEqual(["arm", "start", "stop"]);
  });

  it("resets after stop: a second UP emits nothing and the next gesture works", () => {
    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD);
    fake.fire("UP");
    events.length = 0;

    fake.fire("UP");
    expect(events).toEqual([]);

    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD);
    fake.fire("UP");
    expect(events).toEqual(["arm", "start", "stop"]);
  });

  it("UP before minHoldMs cancels, never starts, and clears the hold timer", () => {
    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD - 1);
    fake.fire("UP");
    expect(events).toEqual(["arm", "cancel"]);

    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["arm", "cancel"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("CHORD before the hold timer cancels once, never starts, and the following UP emits nothing", () => {
    fake.fire("DOWN");
    fake.fire("CHORD");
    expect(events).toEqual(["arm", "cancel"]);

    vi.advanceTimersByTime(1_000);
    fake.fire("UP");
    expect(events).toEqual(["arm", "cancel"]);
  });

  it("a second CHORD during the same hold is ignored", () => {
    fake.fire("DOWN");
    fake.fire("CHORD");
    fake.fire("CHORD");
    fake.fire("UP");
    expect(events.filter((e) => e === "cancel")).toHaveLength(1);
  });

  it("CHORD after start cancels, and the UP afterwards emits nothing (no stop, no second cancel)", () => {
    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD);
    fake.fire("CHORD");
    expect(events).toEqual(["arm", "start", "cancel"]);

    fake.fire("UP");
    expect(events).toEqual(["arm", "start", "cancel"]);
  });

  it("a new gesture right after a chord is not poisoned by the previous one", () => {
    fake.fire("DOWN");
    fake.fire("CHORD");
    fake.fire("UP");
    events.length = 0;

    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD);
    fake.fire("UP");
    expect(events).toEqual(["arm", "start", "stop"]);
  });

  it("ignores a duplicate DOWN while held (one arm, one start)", () => {
    fake.fire("DOWN");
    fake.fire("DOWN");
    vi.advanceTimersByTime(HOLD);
    expect(events).toEqual(["arm", "start"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores CHORD and UP when no key is held", () => {
    fake.fire("CHORD");
    fake.fire("UP");
    vi.advanceTimersByTime(1_000);
    expect(events).toEqual([]);
  });

  it("uses a 150 ms default hold: nothing at 149 ms, start at 150 ms", () => {
    const defaulted = new PTTManager({ native: fake.native });
    const seen = record(defaulted);
    defaulted.start();
    seen.length = 0;

    fake.fire("DOWN");
    vi.advanceTimersByTime(149);
    expect(seen).toEqual(["arm"]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual(["arm", "start"]);
  });

  it("stop() clears a pending hold timer so no late start fires", () => {
    fake.fire("DOWN");
    ptt.stop();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(1_000);
    expect(events).toEqual(["arm"]);
  });
});

describe("PTTManager.start / stop / isTrusted", () => {
  it("untrusted: requests trust, emits trustRequired, returns false, never installs the monitor", () => {
    const fake = makeControllableNative({ trusted: false });
    const ptt = new PTTManager({ native: fake.native });
    const events = record(ptt);

    expect(ptt.start()).toBe(false);

    expect(fake.native.requestTrust).toHaveBeenCalledTimes(1);
    expect(fake.native.start).not.toHaveBeenCalled();
    expect(events).toEqual(["trustRequired"]);
  });

  it("emits trustRequired and no ready when the native monitor fails to install", () => {
    const fake = makeControllableNative({ installs: false });
    const ptt = new PTTManager({ native: fake.native });
    const events = record(ptt);

    expect(ptt.start()).toBe(false);
    expect(events).toEqual(["trustRequired"]);
  });

  it("trusted: emits ready once, and a second start() is idempotent", () => {
    const fake = makeControllableNative();
    const ptt = new PTTManager({ native: fake.native });
    const events = record(ptt);

    expect(ptt.start()).toBe(true);
    expect(ptt.start()).toBe(true);

    expect(fake.native.start).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["ready"]);
  });

  it("stop() stops the native monitor once; stop() when not running is a no-op", () => {
    const fake = makeControllableNative();
    const ptt = new PTTManager({ native: fake.native });

    ptt.stop();
    expect(fake.native.stop).not.toHaveBeenCalled();

    ptt.start();
    ptt.stop();
    ptt.stop();
    expect(fake.native.stop).toHaveBeenCalledTimes(1);
  });

  it("can be started again after stop()", () => {
    const fake = makeControllableNative();
    const ptt = new PTTManager({ native: fake.native });
    ptt.start();
    ptt.stop();
    expect(ptt.start()).toBe(true);
    expect(fake.native.start).toHaveBeenCalledTimes(2);
  });

  it("isTrusted() forwards to the native addon", () => {
    const fake = makeControllableNative({ trusted: false });
    const ptt = new PTTManager({ native: fake.native });
    expect(ptt.isTrusted()).toBe(false);
    fake.native.isTrusted.mockReturnValue(true);
    expect(ptt.isTrusted()).toBe(true);
  });
});

describe("PTTManager.requestTrust", () => {
  it("forwards to the native addon and returns its answer", () => {
    const fake = makeFakeNative();
    const requestTrust = vi.fn(() => false);
    const ptt = new PTTManager({ native: { ...fake.native, requestTrust } });
    expect(ptt.requestTrust()).toBe(false);
    expect(requestTrust).toHaveBeenCalledTimes(1);
  });
});
