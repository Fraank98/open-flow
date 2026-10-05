import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PipelineCoordinator,
  PipelineState,
  CoordinatorDeps,
  PASTE_FAILED_NOTICE_MS,
} from "../../src/main/pipeline-coordinator.js";

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    transcribe: vi.fn(async () => ({ text: "raw transcript", language: "en", durationMs: 100 })),
    clean: vi.fn(async () => ({ text: "Cleaned transcript.", usedFallback: false, durationMs: 50 })),
    inject: vi.fn(async () => ({ pasted: true, clipboardWritten: true })),
    logger: {
      info: vi.fn(async () => undefined),
      error: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
      debug: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe("PipelineCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in 'idle' state", () => {
    const coord = new PipelineCoordinator(makeDeps());
    expect(coord.getState()).toBe<PipelineState>("idle");
  });

  it("transitions through full pipeline when audio is supplied", async () => {
    const deps = makeDeps();
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    expect(coord.getState()).toBe<PipelineState>("recording");

    const samples = new Float32Array(16000);
    await coord.finishWithAudio(samples, 16000, "auto");

    expect(states).toEqual<PipelineState[]>([
      "recording",
      "transcribing",
      "cleaning",
      "injecting",
      "idle",
    ]);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.clean).toHaveBeenCalledWith("raw transcript", expect.anything());
    expect(deps.inject).toHaveBeenCalledWith("Cleaned transcript.", expect.anything());
  });

  it("transitions to error when transcribe throws", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => { throw new Error("whisper crash"); }),
    });
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(8000), 16000, "auto");

    expect(states).toContain<PipelineState>("error");
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.clean).not.toHaveBeenCalled();
    expect(deps.inject).not.toHaveBeenCalled();
  });

  it("skips inject and stays meaningful when transcript is empty", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "", language: null, durationMs: 50 })),
    });
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(8000), 16000, "auto");

    expect(deps.clean).not.toHaveBeenCalled();
    expect(deps.inject).not.toHaveBeenCalled();
    expect(states).toContain<PipelineState>("idle");
  });

  it("can be cancelled while recording", () => {
    const deps = makeDeps();
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    coord.cancel();
    expect(coord.getState()).toBe<PipelineState>("idle");
  });

  it("ignores startRecording while not idle", () => {
    const coord = new PipelineCoordinator(makeDeps());
    coord.startRecording();
    coord.startRecording();
    expect(coord.getState()).toBe<PipelineState>("recording");
  });

  it("applies dictionary correction before the LLM cleanup", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "ho usato slack", language: "it", durationMs: 1 })),
    });
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "it", {
      useLlmCleanup: true,
      dictionary: ["Slack"],
    });
    // The LLM must receive the dictionary-corrected text, not the raw one.
    expect(deps.clean).toHaveBeenCalledWith("ho usato Slack", expect.anything());
  });

  it("applies dictionary correction even when LLM cleanup is off", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "ho usato slack", language: "it", durationMs: 1 })),
    });
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "it", {
      useLlmCleanup: false,
      dictionary: ["Slack"],
    });
    expect(deps.inject).toHaveBeenCalledWith("ho usato Slack", expect.anything());
  });

  it("aborts the injector's signal and does not log pipeline success when cancelled during injecting", async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveInject!: (v: { pasted: boolean; clipboardWritten: boolean; reason?: string }) => void;
    const pending = new Promise<{ pasted: boolean; clipboardWritten: boolean; reason?: string }>((resolve) => {
      resolveInject = resolve;
    });
    const deps = makeDeps({
      inject: vi.fn((_text: string, signal?: AbortSignal) => {
        capturedSignal = signal;
        return pending;
      }),
    });
    const coord = new PipelineCoordinator(deps);
    const states: PipelineState[] = [];
    coord.onStateChange((s) => states.push(s));

    coord.startRecording();
    const finishPromise = coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

    // Drain microtasks (no real timers) until the pipeline has reached
    // "injecting" and is awaiting our controlled `pending` promise.
    for (let i = 0; i < 30 && !states.includes("injecting"); i++) {
      await Promise.resolve();
    }
    expect(states).toContain<PipelineState>("injecting");
    expect(deps.inject).toHaveBeenCalledOnce();

    coord.cancel();
    expect(capturedSignal?.aborted).toBe(true);
    expect(coord.getState()).toBe<PipelineState>("idle");

    // Simulate the real TextInjector's behavior once osascript is killed by
    // the abort: it resolves to pasted=false, it never rejects.
    resolveInject({ pasted: false, clipboardWritten: true, reason: "aborted" });
    await finishPromise;

    expect(coord.getState()).toBe<PipelineState>("idle");
    expect(deps.logger.info).not.toHaveBeenCalledWith("pipeline done", expect.anything());
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it("uses a fresh abort controller per run so a cancelled run does not poison the next", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const deps = makeDeps({
      inject: vi.fn((_text: string, signal?: AbortSignal) => {
        signals.push(signal);
        return Promise.resolve({ pasted: true, clipboardWritten: true });
      }),
    });
    const coord = new PipelineCoordinator(deps);

    coord.startRecording();
    coord.cancel(); // aborts the first run's controller before it ever injects

    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("applies dictionary correction on the short-word lightTouchUp path", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => ({ text: "slack", language: "en", durationMs: 1 })),
    });
    const coord = new PipelineCoordinator(deps);
    coord.startRecording();
    await coord.finishWithAudio(new Float32Array(16000), 16000, "en", {
      useLlmCleanup: true,
      dictionary: ["Slack"],
    });
    // "slack" is a short single word → LLM is skipped and lightTouchUp runs on
    // the dictionary-corrected text, so inject gets "Slack." (capitalized + period).
    expect(deps.clean).not.toHaveBeenCalled();
    expect(deps.inject).toHaveBeenCalledWith("Slack.", expect.anything());
  });

  describe("paste-failed notice", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("enters 'paste-failed' on a genuine paste failure and auto-returns to idle after PASTE_FAILED_NOTICE_MS", async () => {
      vi.useFakeTimers();
      const deps = makeDeps({
        inject: vi.fn(async () => ({ pasted: false, clipboardWritten: true, reason: "boom" })),
      });
      const coord = new PipelineCoordinator(deps);
      coord.startRecording();
      await coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

      expect(coord.getState()).toBe<PipelineState>("paste-failed");

      await vi.advanceTimersByTimeAsync(PASTE_FAILED_NOTICE_MS);
      expect(coord.getState()).toBe<PipelineState>("idle");
    });

    it("enters 'copy-failed' (not 'paste-failed') when the transcript never reached the clipboard, then auto-returns to idle", async () => {
      vi.useFakeTimers();
      const deps = makeDeps({
        inject: vi.fn(async () => ({ pasted: false, clipboardWritten: false, reason: "clipboard write timed out" })),
      });
      const states: PipelineState[] = [];
      const coord = new PipelineCoordinator(deps);
      coord.onStateChange((s) => states.push(s));
      coord.startRecording();
      await coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

      expect(coord.getState()).toBe<PipelineState>("copy-failed");
      expect(states).not.toContain<PipelineState>("paste-failed");

      await vi.advanceTimersByTimeAsync(PASTE_FAILED_NOTICE_MS);
      expect(coord.getState()).toBe<PipelineState>("idle");
    });

    it("does NOT enter 'paste-failed' when pasted:false was caused by a cancel — goes straight to idle", async () => {
      vi.useFakeTimers();
      let resolveInject!: (v: { pasted: boolean; clipboardWritten: boolean; reason?: string }) => void;
      const pending = new Promise<{ pasted: boolean; clipboardWritten: boolean; reason?: string }>((resolve) => {
        resolveInject = resolve;
      });
      const deps = makeDeps({
        inject: vi.fn(() => pending),
      });
      const coord = new PipelineCoordinator(deps);
      coord.startRecording();
      const finishPromise = coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

      for (let i = 0; i < 30 && coord.getState() !== "injecting"; i++) {
        await Promise.resolve();
      }
      expect(coord.getState()).toBe<PipelineState>("injecting");

      coord.cancel();
      resolveInject({ pasted: false, clipboardWritten: true, reason: "aborted" });
      await finishPromise;

      expect(coord.getState()).toBe<PipelineState>("idle");

      // No lingering timer should later flip it to "paste-failed" or otherwise.
      await vi.advanceTimersByTimeAsync(PASTE_FAILED_NOTICE_MS);
      expect(coord.getState()).toBe<PipelineState>("idle");
    });

    it("a successful paste still goes straight to idle (no paste-failed detour)", async () => {
      const deps = makeDeps(); // default inject resolves { pasted: true, clipboardWritten: true }
      const coord = new PipelineCoordinator(deps);
      const states: PipelineState[] = [];
      coord.onStateChange((s) => states.push(s));

      coord.startRecording();
      await coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

      expect(states).not.toContain<PipelineState>("paste-failed");
      expect(coord.getState()).toBe<PipelineState>("idle");
    });

    it("startRecording works from 'paste-failed', and the pending auto-return timer does not knock the new run out of 'recording'", async () => {
      vi.useFakeTimers();
      const deps = makeDeps({
        inject: vi.fn(async () => ({ pasted: false, clipboardWritten: true })),
      });
      const coord = new PipelineCoordinator(deps);
      coord.startRecording();
      await coord.finishWithAudio(new Float32Array(16000), 16000, "auto");
      expect(coord.getState()).toBe<PipelineState>("paste-failed");

      coord.startRecording();
      expect(coord.getState()).toBe<PipelineState>("recording");

      // The guarded timer from the paste-failed run must no-op now that the
      // state has moved on to a new "recording" run.
      await vi.advanceTimersByTimeAsync(PASTE_FAILED_NOTICE_MS);
      expect(coord.getState()).toBe<PipelineState>("recording");
    });

    it("startRecording works from 'error', and the pending auto-return timer does not knock the new run out of 'recording'", async () => {
      vi.useFakeTimers();
      const deps = makeDeps({
        transcribe: vi.fn(async () => {
          throw new Error("whisper crash");
        }),
      });
      const coord = new PipelineCoordinator(deps);
      coord.startRecording();
      await coord.finishWithAudio(new Float32Array(8000), 16000, "auto");
      expect(coord.getState()).toBe<PipelineState>("error");

      coord.startRecording();
      expect(coord.getState()).toBe<PipelineState>("recording");

      await vi.advanceTimersByTimeAsync(2000);
      expect(coord.getState()).toBe<PipelineState>("recording");
    });

    it("still refuses startRecording during transcribing, cleaning, and injecting", async () => {
      let resolveTranscribe!: (v: { text: string; language: string | null; durationMs: number }) => void;
      let resolveClean!: (v: { text: string; usedFallback: boolean; durationMs: number }) => void;
      let resolveInject!: (v: { pasted: boolean; clipboardWritten: boolean }) => void;
      const deps = makeDeps({
        transcribe: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveTranscribe = resolve;
            }),
        ),
        clean: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveClean = resolve;
            }),
        ),
        inject: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveInject = resolve;
            }),
        ),
      });
      const coord = new PipelineCoordinator(deps);
      coord.startRecording();
      const finishPromise = coord.finishWithAudio(new Float32Array(16000), 16000, "auto");

      // The state flips to "transcribing" a tick before deps.transcribe is
      // actually invoked (an intervening logger.info await), so wait for the
      // mock itself to be called rather than just the state.
      for (let i = 0; i < 30 && (deps.transcribe as ReturnType<typeof vi.fn>).mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(coord.getState()).toBe<PipelineState>("transcribing");
      coord.startRecording();
      expect(coord.getState()).toBe<PipelineState>("transcribing");
      resolveTranscribe({ text: "raw transcript", language: "en", durationMs: 1 });

      for (let i = 0; i < 30 && coord.getState() !== "cleaning"; i++) {
        await Promise.resolve();
      }
      expect(coord.getState()).toBe<PipelineState>("cleaning");
      coord.startRecording();
      expect(coord.getState()).toBe<PipelineState>("cleaning");
      resolveClean({ text: "Cleaned transcript.", usedFallback: false, durationMs: 1 });

      for (let i = 0; i < 30 && coord.getState() !== "injecting"; i++) {
        await Promise.resolve();
      }
      expect(coord.getState()).toBe<PipelineState>("injecting");
      coord.startRecording();
      expect(coord.getState()).toBe<PipelineState>("injecting");
      resolveInject({ pasted: true, clipboardWritten: true });

      await finishPromise;
      expect(coord.getState()).toBe<PipelineState>("idle");
    });
  });
});
