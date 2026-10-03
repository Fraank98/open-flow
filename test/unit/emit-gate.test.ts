import { describe, it, expect } from "vitest";
import { createEmitGate } from "../../src/main/utils/emit-gate.js";

describe("createEmitGate", () => {
  it("lets the first event through and drops the ones inside the interval", () => {
    let t = 1000;
    const gate = createEmitGate(100, () => t);
    expect(gate()).toBe(true);
    t += 10;
    expect(gate()).toBe(false);
    t += 89;
    expect(gate()).toBe(false);
    t += 1; // exactly 100 ms since the last emitted event
    expect(gate()).toBe(true);
  });

  it("caps a burst of 50 000 events to about 10 per second", () => {
    let t = 0;
    const gate = createEmitGate(100, () => t);
    let passed = 0;
    for (let i = 0; i < 50_000; i++) {
      t += 0.02; // 50 000 events over one second
      if (gate()) passed++;
    }
    expect(passed).toBeGreaterThanOrEqual(9);
    expect(passed).toBeLessThanOrEqual(11);
  });

  it("always lets a forced event (the last, 100%) through, and restarts the interval from it", () => {
    let t = 0;
    const gate = createEmitGate(100, () => t);
    expect(gate()).toBe(true);
    t += 5;
    expect(gate(true)).toBe(true);
    t += 50;
    expect(gate()).toBe(false); // 50 ms after the forced one
    t += 50;
    expect(gate()).toBe(true);
  });
});
