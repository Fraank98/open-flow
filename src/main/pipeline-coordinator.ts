import { encodeWav } from "./utils/wav-encoder.js";
import { applySpokenPunctuation } from "./utils/spoken-punctuation.js";
import { lightTouchUp } from "./utils/light-touch-up.js";
import { applyDictionary } from "./utils/dictionary.js";

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
  (raw: string, languageHint?: string): Promise<{ text: string; usedFallback: boolean; durationMs: number; skipped?: boolean }>;
}

export interface InjectFn {
  (text: string, signal?: AbortSignal): Promise<{ pasted: boolean; reason?: string }>;
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
  // One AbortController per run, created fresh in startRecording so a
  // cancelled run's abort can never leak into the next run's inject() call.
  private abortController: AbortController | null = null;

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
    this.abortController = new AbortController();
    this.setState("recording");
  }

  cancel(): void {
    if (this.state === "idle") return;
    this.cancelled = true;
    // Abort whatever inject() call may be in flight so a stuck osascript
    // gets killed immediately instead of firing a stray ⌘V later into
    // whatever app happens to be focused by then. Harmless no-op if inject
    // hasn't started yet or has already finished.
    this.abortController?.abort();
    this.setState("idle");
  }

  async finishWithAudio(
    samples: Float32Array,
    sampleRate: number,
    language: string,
    options: { useLlmCleanup?: boolean; spokenPunctuation?: boolean; dictionary?: string[] } = {},
  ): Promise<void> {
    if (this.state !== "recording") return;
    const useLlmCleanup = options.useLlmCleanup !== false; // default true
    const spokenPunctuation = options.spokenPunctuation === true; // default false
    const dictionary = options.dictionary ?? [];

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

      // Optional spoken-punctuation commands ("comma", "virgola", "question
      // mark", …). Deterministic but ambiguous with common nouns ("my
      // period", "il punto della questione"), so it's opt-in. When enabled,
      // it runs BEFORE the LLM so the symbols are normal punctuation in the
      // text the LLM polishes.
      const langHint = language !== "auto" ? language : t.language ?? undefined;
      let withPunct = t.text;
      if (spokenPunctuation) {
        withPunct = applySpokenPunctuation(t.text, langHint ?? "auto");
        if (withPunct !== t.text) {
          await this.deps.logger.info("spoken punctuation applied", { text: withPunct });
        }
      }

      // Deterministic dictionary normalization (preferred spellings of proper
      // nouns / jargon). Runs after spoken-punctuation and before the LLM so
      // the corrected spelling is what the (removal-only) LLM polishes. No-op
      // fast path on an empty dictionary. Applies with or without LLM cleanup.
      let corrected = withPunct;
      if (dictionary.length > 0) {
        corrected = applyDictionary(withPunct, dictionary);
        if (corrected !== withPunct) {
          await this.deps.logger.info("dictionary applied", { text: corrected });
        }
      }

      let textToInject = corrected;
      // Skip the LLM for single-word / very short inputs. Small models like
      // Qwen 1.5B routinely degenerate on near-empty prompts, inventing
      // narration / HTML tags / fake punctuation. For these inputs the raw
      // Whisper output is already good enough — just capitalize and add a
      // trailing period.
      const isSingleShortWord = corrected.length < 12 && !corrected.trim().includes(" ");
      if (useLlmCleanup && isSingleShortWord) {
        await this.deps.logger.info("skipping LLM for short single-word input", {
          length: corrected.length,
        });
        textToInject = lightTouchUp(corrected);
      } else if (useLlmCleanup) {
        this.setState("cleaning");
        const c = await this.deps.clean(corrected, langHint ?? undefined);
        await this.deps.logger.info("cleaned", {
          text: c.text,
          usedFallback: c.usedFallback,
          skipped: c.skipped ?? false,
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
      const r = await this.deps.inject(textToInject, this.abortController?.signal);
      if (!r.pasted) {
        // Also the landing spot for a cancel-triggered abort: TextInjector
        // catches the kill and resolves pasted=false rather than throwing,
        // so this is a warn, never the pipeline-failure error path below.
        await this.deps.logger.warn("paste failed, text left in clipboard", { reason: r.reason });
      }
      if (this.cancelled) {
        this.setState("idle");
        return;
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
