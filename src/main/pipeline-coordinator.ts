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

  async finishWithAudio(
    samples: Float32Array,
    sampleRate: number,
    language: string,
    options: { useLlmCleanup?: boolean } = {},
  ): Promise<void> {
    if (this.state !== "recording") return;
    const useLlmCleanup = options.useLlmCleanup !== false; // default true

    const totalStart = Date.now();
    try {
      this.setState("transcribing");
      const wavBytes = encodeWav(samples, sampleRate);
      await this.deps.logger.info("pipeline start", {
        audioSamples: samples.length,
        audioSeconds: +(samples.length / sampleRate).toFixed(2),
        language,
        useLlmCleanup,
      });
      const t = await this.deps.transcribe({ wavBytes, language });
      await this.deps.logger.info("transcribed", {
        text: t.text,
        detectedLang: t.language,
        durationMs: t.durationMs,
      });
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      if (t.text.trim().length === 0) {
        await this.deps.logger.info("empty transcript, skipping pipeline");
        this.setState("idle");
        return;
      }

      let textToInject = t.text;
      if (useLlmCleanup) {
        this.setState("cleaning");
        const c = await this.deps.clean(t.text);
        await this.deps.logger.info("cleaned", {
          text: c.text,
          usedFallback: c.usedFallback,
          durationMs: c.durationMs,
        });
        if (this.cancelled) {
          this.setState("idle");
          return;
        }
        textToInject = c.text;
      } else {
        await this.deps.logger.info("LLM cleanup disabled — using raw transcript");
      }

      this.setState("injecting");
      const r = await this.deps.inject(textToInject);
      if (!r.pasted) {
        await this.deps.logger.warn("paste failed, text left in clipboard", { reason: r.reason });
      }
      await this.deps.logger.info("pipeline done", { totalMs: Date.now() - totalStart });
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
