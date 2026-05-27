import { describe, it, expect, vi } from "vitest";
import { StreamingWhisperRunner, computeNewSuffix, PassInfo } from "../../src/main/streaming-whisper-runner.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ChunkCb = (err: Error | null, text: string, info?: PassInfo) => void;

/**
 * Fake native addon for testing the runner's orchestration without loading the
 * real .node. A processChunk stays "in flight" until either its slow timer
 * fires (simulating inference finishing on its own) or requestAbort() cuts it
 * short (simulating the abort_callback bailing whisper_full out early).
 */
function makeFakeNative(opts: { chunkResolveMs?: number } = {}) {
  const calls: string[] = [];
  let keepaliveCount = 0;
  let pendingCb: ChunkCb | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resolve = (text: string, info: PassInfo) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingCb) {
      const cb = pendingCb;
      pendingCb = null;
      cb(null, text, info);
    }
  };
  const native = {
    init: () => true,
    start: () => void calls.push("start"),
    feedSamples: () => {},
    processChunk: (_lang: string, cb: ChunkCb) => {
      calls.push("processChunk");
      pendingCb = cb;
      const ms = opts.chunkResolveMs ?? 200;
      timer = setTimeout(() => resolve("stale partial", { queueMs: 0, execMs: ms, aborted: false }), ms);
    },
    requestAbort: () => {
      calls.push("requestAbort");
      resolve("", { queueMs: 0, execMs: 3, aborted: true });
    },
    finalize: (_lang: string, cb: ChunkCb) => {
      calls.push("finalize");
      cb(null, "final text", { queueMs: 0, execMs: 10, aborted: false });
    },
    keepalive: (cb: ChunkCb) => {
      keepaliveCount++;
      cb(null, "", { queueMs: 0, execMs: 1, aborted: false });
    },
    release: () => void calls.push("release"),
  };
  return { calls, native, hasPending: () => pendingCb !== null, keepaliveCount: () => keepaliveCount };
}

describe("StreamingWhisperRunner.finalize", () => {
  it("aborts the in-flight chunk before running the final pass", async () => {
    // Slow chunk: if finalize naively awaited it, this test would take ~5s.
    // The abort must cut it short and keep the two passes strictly serialized.
    const fake = makeFakeNative({ chunkResolveMs: 5000 });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 5, native: fake.native });
    runner.start("it");
    await delay(25); // let exactly one chunk go in flight
    expect(fake.hasPending()).toBe(true);

    const text = await runner.finalize("it");

    expect(text).toBe("final text");
    // requestAbort must come after the in-flight chunk and before the final pass.
    expect(fake.calls).toEqual(["start", "processChunk", "requestAbort", "finalize"]);
  });
});

describe("StreamingWhisperRunner timing instrumentation", () => {
  it("emits a 'timing' event with native exec timing for each pass", async () => {
    const fake = makeFakeNative({ chunkResolveMs: 200 });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 5, native: fake.native });
    const events: Array<{ phase: string; execMs: number; aborted: boolean }> = [];
    runner.on("timing", (e) => events.push(e));

    runner.start("it");
    await delay(25); // one chunk in flight
    await runner.finalize("it");

    const phases = events.map((e) => e.phase);
    expect(phases).toContain("chunk");
    expect(phases).toContain("final");
    expect(events.find((e) => e.phase === "final")?.execMs).toBe(10);
  });
});

describe("StreamingWhisperRunner GPU keepalive", () => {
  it("runs a keepalive pass while idle to keep the GPU warm", async () => {
    vi.useFakeTimers();
    const fake = makeFakeNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native: fake.native, keepaliveIntervalMs: 50 });
    // never call start() — the runner is idle
    await vi.advanceTimersByTimeAsync(160); // ~3 keepalive ticks
    expect(fake.keepaliveCount()).toBeGreaterThanOrEqual(1);
    runner.release();
    vi.useRealTimers();
  });

  it("does not run keepalive while recording (the chunk loop warms the GPU)", async () => {
    vi.useFakeTimers();
    const fake = makeFakeNative({ chunkResolveMs: 10_000 });
    const runner = new StreamingWhisperRunner({
      modelPath: "m",
      native: fake.native,
      keepaliveIntervalMs: 50,
      chunkIntervalMs: 1000,
    });
    runner.start("it"); // active — recording
    await vi.advanceTimersByTimeAsync(160);
    expect(fake.keepaliveCount()).toBe(0);
    runner.cancel();
    runner.release();
    vi.useRealTimers();
  });
});

describe("computeNewSuffix", () => {
  it("returns the full current when committed is empty", () => {
    expect(computeNewSuffix("", "hello world")).toBe("hello world");
  });

  it("returns empty when current is identical to committed", () => {
    expect(computeNewSuffix("hello world", "hello world")).toBe("");
  });

  it("returns only the words appended in current", () => {
    expect(computeNewSuffix("hello world", "hello world today")).toBe("today");
    expect(computeNewSuffix("ciao", "ciao come stai")).toBe("come stai");
  });

  it("matches case-insensitively on token prefix", () => {
    expect(computeNewSuffix("Hello World", "hello world today")).toBe("today");
  });

  it("collapses multiple whitespace between tokens", () => {
    expect(computeNewSuffix("hello   world", "hello world today")).toBe("today");
  });

  it("treats a diverged word as the start of the new suffix", () => {
    // Whisper changes its mind on word 2 — everything from there is the new tail.
    expect(computeNewSuffix("hello world", "hello mondo today")).toBe("mondo today");
  });

  it("returns trimmed empty string when current is whitespace", () => {
    expect(computeNewSuffix("hello world", "   ")).toBe("");
  });
});
