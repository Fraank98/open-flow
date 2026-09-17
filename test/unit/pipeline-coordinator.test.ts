import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PipelineCoordinator,
  PipelineState,
  CoordinatorDeps,
} from "../../src/main/pipeline-coordinator.js";

function makeDeps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    transcribe: vi.fn(async () => ({ text: "raw transcript", language: "en", durationMs: 100 })),
    clean: vi.fn(async () => ({ text: "Cleaned transcript.", usedFallback: false, durationMs: 50 })),
    inject: vi.fn(async () => ({ pasted: true })),
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
    let resolveInject!: (v: { pasted: boolean; reason?: string }) => void;
    const pending = new Promise<{ pasted: boolean; reason?: string }>((resolve) => {
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
    resolveInject({ pasted: false, reason: "aborted" });
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
        return Promise.resolve({ pasted: true });
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
});
