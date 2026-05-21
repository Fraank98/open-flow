import { describe, it, expect, beforeEach } from "vitest";
import { AudioOrchestrator } from "../../src/main/audio-orchestrator.js";

describe("AudioOrchestrator", () => {
  let orch: AudioOrchestrator;
  beforeEach(() => {
    orch = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: 16_000 });
  });

  it("starts empty", () => {
    expect(orch.totalSamples()).toBe(0);
    expect(orch.snapshot().length).toBe(0);
  });

  it("concatenates appended chunks in order", () => {
    orch.appendChunk(new Float32Array([0.1, 0.2]));
    orch.appendChunk(new Float32Array([0.3, 0.4, 0.5]));
    expect(orch.totalSamples()).toBe(5);
    const snap = orch.snapshot();
    const expected = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(snap.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(snap[i]).toBeCloseTo(expected[i]!, 5);
    }
  });

  it("reset() clears all chunks", () => {
    orch.appendChunk(new Float32Array([1, 2, 3]));
    orch.reset();
    expect(orch.totalSamples()).toBe(0);
  });

  it("truncates oldest samples beyond maxDurationMs (sliding window)", () => {
    const orch2 = new AudioOrchestrator({ maxDurationMs: 1, sampleRate: 1_000 });
    // 1 ms at 1000 Hz = 1 sample cap
    orch2.appendChunk(new Float32Array([1]));
    orch2.appendChunk(new Float32Array([2]));
    orch2.appendChunk(new Float32Array([3]));
    expect(orch2.totalSamples()).toBe(1);
    expect(orch2.snapshot()[0]).toBe(3);
  });

  it("rms() returns 0 for empty buffer", () => {
    expect(orch.rms()).toBe(0);
  });

  it("rms() returns positive value for non-silent buffer", () => {
    orch.appendChunk(new Float32Array([0.5, -0.5, 0.5, -0.5]));
    expect(orch.rms()).toBeCloseTo(0.5, 5);
  });
});
