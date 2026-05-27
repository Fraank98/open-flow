import { describe, it, expect, vi } from "vitest";
import { startKeepalive } from "../../src/main/utils/keepalive.js";

describe("startKeepalive", () => {
  it("calls ping on each interval until stopped", async () => {
    vi.useFakeTimers();
    let pings = 0;
    const stop = startKeepalive(async () => {
      pings++;
    }, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(pings).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(300);
    expect(pings).toBe(3); // no further pings after stop()
    vi.useRealTimers();
  });

  it("keeps firing even when a ping rejects", async () => {
    vi.useFakeTimers();
    let pings = 0;
    const stop = startKeepalive(async () => {
      pings++;
      throw new Error("transient");
    }, 100);
    await vi.advanceTimersByTimeAsync(250);
    expect(pings).toBe(2);
    stop();
    vi.useRealTimers();
  });
});
