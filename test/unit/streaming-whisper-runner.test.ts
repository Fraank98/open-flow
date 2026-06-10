import { describe, it, expect, vi, afterEach } from "vitest";
import { StreamingWhisperRunner, computeNewSuffix, PassInfo } from "../../src/main/streaming-whisper-runner.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Safety net: a test that throws mid-way (before its own useRealTimers) must not
// leak fake timers into the next test and hang it on a real-time delay().
afterEach(() => {
  vi.useRealTimers();
});

type ChunkCb = (err: Error | null, text: string, info?: PassInfo) => void;

/**
 * Fake native addon for testing the runner's orchestration without loading the
 * real .node. A processChunk stays "in flight" until either its slow timer
 * fires (simulating inference finishing on its own) or requestAbort() cuts it
 * short (simulating the abort_callback bailing whisper_full out early).
 */
function makeFakeNative(opts: { chunkResolveMs?: number; deferFinalize?: boolean } = {}) {
  const calls: string[] = [];
  let keepaliveCount = 0;
  let pendingCb: ChunkCb | null = null;
  let pendingFinalizeCb: ChunkCb | null = null;
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
      // When deferred, hold the callback so the final pass stays "in flight"
      // under test control — simulates a final whisper_full still running on a
      // worker thread, the window in which a keepalive tick could race it.
      if (opts.deferFinalize) {
        pendingFinalizeCb = cb;
        return;
      }
      cb(null, "final text", { queueMs: 0, execMs: 10, aborted: false });
    },
    keepalive: (cb: ChunkCb) => {
      keepaliveCount++;
      cb(null, "", { queueMs: 0, execMs: 1, aborted: false });
    },
    release: () => void calls.push("release"),
  };
  const resolveFinalize = () => {
    const cb = pendingFinalizeCb;
    pendingFinalizeCb = null;
    cb?.(null, "final text", { queueMs: 0, execMs: 10, aborted: false });
  };
  return {
    calls,
    native,
    hasPending: () => pendingCb !== null,
    keepaliveCount: () => keepaliveCount,
    resolveFinalize,
  };
}

/**
 * Fake native whose passes NEVER invoke their callback — simulates a
 * whisper_full / Metal stall that holds the inference mutex forever. Used to
 * exercise the runner's watchdog (the JS side must not wedge indefinitely).
 */
function makeHangingNative() {
  const calls: string[] = [];
  let keepaliveCount = 0;
  const native = {
    init: () => true,
    start: () => void calls.push("start"),
    feedSamples: () => {},
    processChunk: (_lang: string, _cb: ChunkCb) => void calls.push("processChunk"), // never calls back
    requestAbort: () => void calls.push("requestAbort"),
    finalize: (_lang: string, _cb: ChunkCb) => void calls.push("finalize"), // never calls back
    keepalive: (_cb: ChunkCb) => {
      keepaliveCount++; // attempted, but never calls back
    },
    release: () => void calls.push("release"),
  };
  return { calls, native, keepaliveCount: () => keepaliveCount };
}

describe("StreamingWhisperRunner watchdog (hung pass recovery)", () => {
  it("emits 'stall' and rejects finalize when the final pass never returns", async () => {
    vi.useFakeTimers();
    const fake = makeHangingNative();
    const runner = new StreamingWhisperRunner({
      modelPath: "m",
      native: fake.native,
      chunkIntervalMs: 1_000_000, // no streaming chunk fires during this test
      passTimeoutMs: 5000,
    });
    const stalls: Array<{ phase: string; timeoutMs: number }> = [];
    runner.on("stall", (e) => stalls.push(e));

    runner.start("it");
    const outcome = runner.finalize("it").then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(5001); // trip the watchdog

    expect(stalls).toEqual([{ phase: "final", timeoutMs: 5000 }]);
    expect(await outcome).toBe("rejected");
    vi.useRealTimers();
  });

  it("emits 'stall' when an idle keepalive pass hangs, and stops scheduling further passes", async () => {
    vi.useFakeTimers();
    const fake = makeHangingNative();
    const runner = new StreamingWhisperRunner({
      modelPath: "m",
      native: fake.native,
      keepaliveIntervalMs: 50,
      passTimeoutMs: 5000,
    });
    const stalls: Array<{ phase: string }> = [];
    runner.on("stall", (e) => stalls.push(e));

    await vi.advanceTimersByTimeAsync(60); // keepalive fires once, then hangs
    expect(fake.keepaliveCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5001); // watchdog trips
    expect(stalls.some((s) => s.phase === "keepalive")).toBe(true);
    await vi.advanceTimersByTimeAsync(500); // keepalive interval must be stopped now
    expect(fake.keepaliveCount()).toBe(1);
    vi.useRealTimers();
  });
});

describe("StreamingWhisperRunner.shutdown", () => {
  it("tears down for quit WITHOUT calling the blocking native release()", async () => {
    vi.useFakeTimers();
    const fake = makeFakeNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native: fake.native, keepaliveIntervalMs: 50 });
    runner.shutdown();
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.calls).not.toContain("release"); // crucial: never block on native release at quit
    expect(fake.keepaliveCount()).toBe(0); // keepalive interval cleared
    vi.useRealTimers();
  });
});

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

  it("does not run keepalive while the final pass is still in flight", async () => {
    // Regression: finalize() set active=false but did NOT track the final pass
    // in `inFlight`, leaving a window where a keepalive tick fired a second
    // whisper_full concurrently with the final pass on the same context →
    // ggml_abort / SIGABRT. The final pass must keep the keepalive guard closed.
    vi.useFakeTimers();
    const fake = makeFakeNative({ deferFinalize: true });
    const runner = new StreamingWhisperRunner({
      modelPath: "m",
      native: fake.native,
      keepaliveIntervalMs: 50,
      chunkIntervalMs: 10_000, // no streaming chunk fires during this test
    });
    runner.start("it");
    const finalP = runner.finalize("it"); // final pass now in flight (deferred)

    await vi.advanceTimersByTimeAsync(160); // ~3 keepalive ticks during the pass
    expect(fake.keepaliveCount()).toBe(0); // must NOT run a concurrent pass

    fake.resolveFinalize();
    expect(await finalP).toBe("final text");
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
