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
    expect(deps.inject).toHaveBeenCalledWith("Cleaned transcript.");
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
});
