import { describe, it, expect, vi, afterEach } from "vitest";
import { StreamingWhisperRunner, computeNewSuffix, PassInfo, PartialTranscript, StallInfo } from "../../src/main/streaming-whisper-runner.js";

// Safety net: a test that throws mid-way (before its own useRealTimers) must not
// leak fake timers into the next test and hang it on a pending timer.
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
      // The abort flag is global native-side: it cuts short whichever pass is
      // in flight, the deferred final pass included.
      if (pendingFinalizeCb) {
        const cb = pendingFinalizeCb;
        pendingFinalizeCb = null;
        cb(null, "", { queueMs: 0, execMs: 3, aborted: true });
      }
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
    vi.useFakeTimers();
    // Slow chunk: if finalize naively awaited it, this test would take ~5s.
    // The abort must cut it short and keep the two passes strictly serialized.
    const fake = makeFakeNative({ chunkResolveMs: 5000 });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 5, native: fake.native });
    runner.start("it");
    await vi.advanceTimersByTimeAsync(25); // let exactly one chunk go in flight
    expect(fake.hasPending()).toBe(true);

    const text = await runner.finalize("it");

    expect(text).toBe("final text");
    // requestAbort must come after the in-flight chunk and before the final pass.
    expect(fake.calls).toEqual(["start", "processChunk", "requestAbort", "finalize"]);
  });
});

describe("StreamingWhisperRunner.cancel", () => {
  it("aborts the final pass so finalize() settles instead of running to completion", async () => {
    const fake = makeFakeNative({ deferFinalize: true });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 10_000, native: fake.native });
    const events: Array<{ phase: string; aborted: boolean }> = [];
    runner.on("timing", (e) => events.push(e));
    runner.start("it");
    const p = runner.finalize("it");
    expect(fake.calls).toEqual(["start", "finalize"]);

    runner.cancel();

    expect(fake.calls).toEqual(["start", "finalize", "requestAbort"]);
    expect(await p).toBe("");
    expect(events.find((e) => e.phase === "final")).toMatchObject({ phase: "final", aborted: true });
  });

  it("aborts an in-flight chunk and emits no partial for it", async () => {
    vi.useFakeTimers();
    const fake = makeFakeNative({ chunkResolveMs: 5000 });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 5, native: fake.native });
    const partials: unknown[] = [];
    runner.on("partial", (e) => partials.push(e));
    runner.start("it");
    await vi.advanceTimersByTimeAsync(25); // let exactly one chunk go in flight
    expect(fake.hasPending()).toBe(true);

    runner.cancel();
    await vi.advanceTimersByTimeAsync(10);

    expect(fake.calls).toEqual(["start", "processChunk", "requestAbort"]);
    expect(fake.hasPending()).toBe(false);
    expect(partials).toEqual([]);
  });

  it("does not raise the native abort when nothing is in flight", () => {
    const fake = makeFakeNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 10_000, native: fake.native });
    runner.start("it");
    runner.cancel();
    expect(fake.calls).toEqual(["start"]);
  });
});

describe("StreamingWhisperRunner timing instrumentation", () => {
  it("emits a 'timing' event with native exec timing for each pass", async () => {
    vi.useFakeTimers();
    const fake = makeFakeNative({ chunkResolveMs: 200 });
    const runner = new StreamingWhisperRunner({ modelPath: "m", chunkIntervalMs: 5, native: fake.native });
    const events: Array<{ phase: string; execMs: number; aborted: boolean }> = [];
    runner.on("timing", (e) => events.push(e));

    runner.start("it");
    await vi.advanceTimersByTimeAsync(25); // one chunk in flight
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

describe("StreamingWhisperRunner.start initial_prompt forwarding", () => {
  it("forwards the initial prompt to the native start()", () => {
    const startArgs: Array<string | undefined> = [];
    const native = {
      init: () => true,
      start: (initialPrompt?: string) => { startArgs.push(initialPrompt); },
      feedSamples: () => {},
      processChunk: (_lang: string, _cb: ChunkCb) => {},
      requestAbort: () => {},
      finalize: (_lang: string, _cb: ChunkCb) => {},
      keepalive: (_cb: ChunkCb) => {},
      release: () => {},
    };
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.start("it", "Slack, Wispr Flow");
    expect(startArgs).toEqual(["Slack, Wispr Flow"]);
    runner.cancel();
  });

  it("forwards an empty string when no prompt is given", () => {
    const startArgs: Array<string | undefined> = [];
    const native = {
      init: () => true,
      start: (initialPrompt?: string) => { startArgs.push(initialPrompt); },
      feedSamples: () => {},
      processChunk: (_lang: string, _cb: ChunkCb) => {},
      requestAbort: () => {},
      finalize: (_lang: string, _cb: ChunkCb) => {},
      keepalive: (_cb: ChunkCb) => {},
      release: () => {},
    };
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.start("it");
    expect(startArgs).toEqual([""]);
    runner.cancel();
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

describe("StreamingWhisperRunner VAD wiring", () => {
  it("forwards the VAD model path to the native init", () => {
    const seen: Array<string | undefined> = [];
    const native = {
      init: (_m: string, vad?: string) => {
        seen.push(vad);
        return true;
      },
      start: () => {},
      feedSamples: () => {},
      processChunk: () => {},
      requestAbort: () => {},
      finalize: () => {},
      keepalive: () => {},
      release: () => {},
    };
    new StreamingWhisperRunner({
      modelPath: "m",
      vadModelPath: "/bin/ggml-silero-v6.2.0.bin",
      native: native as never,
    });
    // Without this the addon runs with VAD off and Whisper hallucinates its
    // training-set filler ("Grazie.", "Thank you.") on silent audio.
    expect(seen).toEqual(["/bin/ggml-silero-v6.2.0.bin"]);
  });

  it("leaves the path undefined when no VAD model is configured", () => {
    const seen: Array<string | undefined> = [];
    const native = {
      init: (_m: string, vad?: string) => {
        seen.push(vad);
        return true;
      },
      start: () => {},
      feedSamples: () => {},
      processChunk: () => {},
      requestAbort: () => {},
      finalize: () => {},
      keepalive: () => {},
      release: () => {},
    };
    new StreamingWhisperRunner({ modelPath: "m", native: native as never });
    expect(seen).toEqual([undefined]);
  });
});

/**
 * Fake native whose passes stay pending until the test answers them, so each
 * test decides what a chunk / final / keepalive callback returns and when.
 */
function makeManualNative(init = true) {
  const chunkCbs: ChunkCb[] = [];
  const finalCbs: ChunkCb[] = [];
  const native = {
    init: vi.fn(() => init),
    start: vi.fn(),
    feedSamples: vi.fn(),
    processChunk: vi.fn((_lang: string, cb: ChunkCb) => void chunkCbs.push(cb)),
    requestAbort: vi.fn(),
    finalize: vi.fn((_lang: string, cb: ChunkCb) => void finalCbs.push(cb)),
    keepalive: vi.fn(),
    release: vi.fn(),
  };
  return { native, chunkCbs, finalCbs };
}

const INFO: PassInfo = { queueMs: 0, execMs: 1, aborted: false };

describe("StreamingWhisperRunner partial transcripts", () => {
  async function tick(ms = 1500) {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it("emits 'partial' once per new text, with the new suffix, and not again for identical text", async () => {
    vi.useFakeTimers();
    const { native, chunkCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    const partials: PartialTranscript[] = [];
    runner.on("partial", (p: PartialTranscript) => partials.push(p));

    runner.start("en");
    await tick();
    chunkCbs.shift()!(null, "hello world", INFO);
    await tick(0);
    expect(partials).toEqual([{ full: "hello world", newSuffix: "hello world" }]);

    await tick();
    chunkCbs.shift()!(null, "hello world today", INFO);
    await tick(0);
    expect(partials).toHaveLength(2);
    expect(partials[1]).toEqual({ full: "hello world today", newSuffix: "today" });

    await tick();
    chunkCbs.shift()!(null, "hello world today", INFO);
    await tick(0);
    expect(partials).toHaveLength(2);
    runner.release();
  });

  it("emits nothing for an empty chunk", async () => {
    vi.useFakeTimers();
    const { native, chunkCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    const onPartial = vi.fn();
    runner.on("partial", onPartial);

    runner.start("en");
    await tick();
    chunkCbs.shift()!(null, "", INFO);
    await tick(0);
    expect(onPartial).not.toHaveBeenCalled();
    runner.release();
  });

  it("emits no partial for a chunk that finishes after cancel()", async () => {
    vi.useFakeTimers();
    const { native, chunkCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    const onPartial = vi.fn();
    runner.on("partial", onPartial);

    runner.start("en");
    await tick();
    runner.cancel();
    chunkCbs.shift()!(null, "late words", INFO);
    await tick(0);
    expect(onPartial).not.toHaveBeenCalled();
    runner.release();
  });

  it("a failing chunk pass is swallowed and the loop keeps going", async () => {
    vi.useFakeTimers();
    const { native, chunkCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    const partials: PartialTranscript[] = [];
    const onStall = vi.fn();
    runner.on("partial", (p: PartialTranscript) => partials.push(p));
    runner.on("stall", onStall);

    runner.start("en");
    await tick();
    chunkCbs.shift()!(new Error("whisper_full failed"), "", undefined);
    await tick();
    expect(native.processChunk).toHaveBeenCalledTimes(2);
    chunkCbs.shift()!(null, "recovered", INFO);
    await tick(0);
    expect(partials).toEqual([{ full: "recovered", newSuffix: "recovered" }]);
    expect(onStall).not.toHaveBeenCalled();
    runner.release();
  });
});

describe("StreamingWhisperRunner lifecycle guards", () => {
  it("throws when the native init fails, naming the model", () => {
    const { native } = makeManualNative(false);
    expect(() => new StreamingWhisperRunner({ modelPath: "/models/ggml-x.bin", native })).toThrow(
      "whisper_stream init failed for /models/ggml-x.bin",
    );
  });

  it("start() after release() throws and does not touch the native side", () => {
    const { native } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.release();
    expect(() => runner.start("en")).toThrow("after release()");
    expect(native.start).not.toHaveBeenCalled();
  });

  it("release() releases the native context and stops the chunk loop", async () => {
    vi.useFakeTimers();
    const { native } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.start("en");
    runner.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(native.release).toHaveBeenCalledOnce();
    expect(native.processChunk).not.toHaveBeenCalled();
  });

  it("finalize() after release() returns '' without a native pass", async () => {
    const { native } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.release();
    await expect(runner.finalize("en")).resolves.toBe("");
    expect(native.finalize).not.toHaveBeenCalled();
  });

  it("finalize() after cancel() returns '' without a final pass", async () => {
    const { native } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.start("en");
    runner.cancel();
    await expect(runner.finalize("en")).resolves.toBe("");
    expect(native.finalize).not.toHaveBeenCalled();
    runner.release();
  });

  it("feedSamples() only reaches the native side while an utterance is active", () => {
    const { native } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    const samples = new Float32Array(4);
    runner.feedSamples(samples);
    expect(native.feedSamples).not.toHaveBeenCalled();
    runner.start("en");
    runner.feedSamples(samples);
    expect(native.feedSamples).toHaveBeenCalledOnce();
    runner.cancel();
    runner.feedSamples(samples);
    expect(native.feedSamples).toHaveBeenCalledOnce();
    runner.release();
  });

  it("a failing final pass rejects finalize() with the native error", async () => {
    const { native, finalCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native });
    runner.start("en");
    const p = runner.finalize("en");
    const assertion = expect(p).rejects.toThrow("whisper_full failed");
    finalCbs.shift()!(new Error("whisper_full failed"), "", undefined);
    await assertion;
    runner.release();
  });
});

describe("StreamingWhisperRunner chunk-phase stall", () => {
  it("emits stall {phase:'chunk'}, stops scheduling, refuses start/finalize, and ignores a late callback", async () => {
    vi.useFakeTimers();
    const { native, chunkCbs } = makeManualNative();
    const runner = new StreamingWhisperRunner({ modelPath: "m", native, passTimeoutMs: 5000 });
    const stalls: StallInfo[] = [];
    const onPartial = vi.fn();
    runner.on("stall", (s: StallInfo) => stalls.push(s));
    runner.on("partial", onPartial);

    runner.start("en");
    await vi.advanceTimersByTimeAsync(1500); // chunk pass starts, never answers
    expect(chunkCbs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stalls).toEqual([{ phase: "chunk", timeoutMs: 5000 }]);

    // The wedged worker finally answers: it must be ignored.
    chunkCbs.shift()!(null, "too late", INFO);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onPartial).not.toHaveBeenCalled();
    expect(native.processChunk).toHaveBeenCalledOnce();

    expect(() => runner.start("en")).toThrow("after a stall");
    await expect(runner.finalize("en")).resolves.toBe("");
    expect(native.finalize).not.toHaveBeenCalled();
    runner.feedSamples(new Float32Array(2));
    expect(native.feedSamples).not.toHaveBeenCalled();
    runner.shutdown();
  });
});
