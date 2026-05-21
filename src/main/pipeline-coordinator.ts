import { encodeWav } from "./utils/wav-encoder.js";

export type PipelineState =
  | "idle"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "injecting"
  | "error";

export interface TranscribeFn {
  (input: { wavBytes: Uint8Array; language: string }): Promise<{
    text: string;
    language: string | null;
    durationMs: number;
  }>;
}

export interface CleanFn {
  (raw: string): Promise<{ text: string; usedFallback: boolean; durationMs: number }>;
}

export interface InjectFn {
  (text: string): Promise<{ pasted: boolean; reason?: string }>;
}

export interface CoordinatorLogger {
  info(msg: string, meta?: Record<string, unknown>): Promise<void>;
  warn(msg: string, meta?: Record<string, unknown>): Promise<void>;
  error(msg: string, meta?: Record<string, unknown>): Promise<void>;
  debug(msg: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface CoordinatorDeps {
  transcribe: TranscribeFn;
  clean: CleanFn;
  inject: InjectFn;
  logger: CoordinatorLogger;
}

export class PipelineCoordinator {
  private state: PipelineState = "idle";
  private listeners: Array<(s: PipelineState) => void> = [];
  private cancelled = false;

  constructor(private readonly deps: CoordinatorDeps) {}

  getState(): PipelineState {
    return this.state;
  }

  onStateChange(cb: (s: PipelineState) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private setState(next: PipelineState): void {
    this.state = next;
    for (const l of this.listeners) {
      l(next);
    }
  }

  startRecording(): void {
    if (this.state !== "idle") return;
    this.cancelled = false;
    this.setState("recording");
  }

  cancel(): void {
    if (this.state === "idle") return;
    this.cancelled = true;
    this.setState("idle");
  }

  async finishWithAudio(samples: Float32Array, sampleRate: number, language: string): Promise<void> {
    if (this.state !== "recording") return;

    try {
      this.setState("transcribing");
      const wavBytes = encodeWav(samples, sampleRate);
      const t = await this.deps.transcribe({ wavBytes, language });
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      if (t.text.trim().length === 0) {
        await this.deps.logger.info("empty transcript, skipping cleanup");
        this.setState("idle");
        return;
      }

      this.setState("cleaning");
      const c = await this.deps.clean(t.text);
      if (this.cancelled) {
        this.setState("idle");
        return;
      }

      this.setState("injecting");
      const r = await this.deps.inject(c.text);
      if (!r.pasted) {
        await this.deps.logger.warn("paste failed, text left in clipboard", { reason: r.reason });
      }
      this.setState("idle");
    } catch (err) {
      await this.deps.logger.error("pipeline failure", {
        message: err instanceof Error ? err.message : String(err),
      });
      this.setState("error");
      // auto-return to idle so user can try again
      setTimeout(() => {
        if (this.state === "error") this.setState("idle");
      }, 2000);
    }
  }
}
