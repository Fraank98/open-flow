import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { waitForEventOrTimeout } from "../../src/main/utils/wait-for-event.js";

describe("waitForEventOrTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true when the event arrives first and leaves no timer or listener", async () => {
    vi.useFakeTimers();
    const em = new EventEmitter();
    const p = waitForEventOrTimeout(em, "eos", 500);
    em.emit("eos");
    expect(await p).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(em.listenerCount("eos")).toBe(0);
  });

  it("resolves false on timeout and removes the listener", async () => {
    vi.useFakeTimers();
    const em = new EventEmitter();
    const p = waitForEventOrTimeout(em, "eos", 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(false);
    expect(em.listenerCount("eos")).toBe(0);
  });

  it("does not let a late event from a timed-out wait leak into the next wait", async () => {
    vi.useFakeTimers();
    const em = new EventEmitter();
    const first = waitForEventOrTimeout(em, "eos", 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toBe(false);

    const second = waitForEventOrTimeout(em, "eos", 500);
    expect(em.listenerCount("eos")).toBe(1);
    em.emit("eos");
    expect(await second).toBe(true);
    expect(em.listenerCount("eos")).toBe(0);
  });

  it("never accumulates listeners across consecutive timeouts", async () => {
    vi.useFakeTimers();
    const em = new EventEmitter();
    for (let i = 0; i < 5; i++) {
      const p = waitForEventOrTimeout(em, "eos", 500);
      await vi.advanceTimersByTimeAsync(500);
      expect(await p).toBe(false);
    }
    expect(em.listenerCount("eos")).toBe(0);
  });

  it("tolerates an event emitted after the timeout already won", async () => {
    vi.useFakeTimers();
    const em = new EventEmitter();
    const p = waitForEventOrTimeout(em, "eos", 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(false);
    expect(() => em.emit("eos")).not.toThrow();
    expect(em.listenerCount("eos")).toBe(0);
  });
});
