import { describe, it, expect, vi, afterEach } from "vitest";
import { createPttArmer, PttArmState } from "../../src/main/utils/ptt-arming.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup(opts: { trusted: () => boolean; startResult?: () => boolean }) {
  const states: PttArmState[] = [];
  const start = vi.fn(opts.startResult ?? (() => true));
  const armer = createPttArmer({
    isTrusted: opts.trusted,
    start,
    intervalMs: 2000,
    onState: (s) => states.push(s),
  });
  return { armer, start, states };
}

describe("createPttArmer", () => {
  it("starts once and reports 'armed' when trusted right away", () => {
    vi.useFakeTimers();
    const { armer, start, states } = setup({ trusted: () => true });
    armer.arm();
    vi.advanceTimersByTime(10_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["armed"]);
  });

  it("waits while untrusted, then starts once after the grant (third tick)", () => {
    vi.useFakeTimers();
    let ticks = 0;
    const { armer, start, states } = setup({
      // first call is the immediate check, then ticks 1..n
      trusted: () => ticks++ >= 3,
    });
    armer.arm();
    expect(states).toEqual(["waiting"]);
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000); // tick 1: ticks=1 -> false
    vi.advanceTimersByTime(2000); // tick 2: ticks=2 -> false
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000); // tick 3: ticks=3 -> true
    expect(start).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["waiting", "armed-after-grant"]);
    vi.advanceTimersByTime(20_000); // timer is done: no more starts
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("asks for a relaunch when start() still fails after the grant", () => {
    vi.useFakeTimers();
    let trusted = false;
    const { armer, start, states } = setup({ trusted: () => trusted, startResult: () => false });
    armer.arm();
    trusted = true;
    vi.advanceTimersByTime(2000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["waiting", "relaunch-needed"]);
  });

  it("stop() ends the polling so a later grant does nothing", () => {
    vi.useFakeTimers();
    let trusted = false;
    const { armer, start } = setup({ trusted: () => trusted });
    armer.arm();
    armer.stop();
    trusted = true;
    vi.advanceTimersByTime(20_000);
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
