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
  | "error"
  | "paste-failed"
  // The paste failed AND the transcript never reached the clipboard (the
  // clipboard write failed or timed out), so the user has nothing to paste by hand.
  | "copy-failed";

// How long the "paste-failed" / "copy-failed" notice stays on screen before auto-returning to
// idle. Longer than the 2000ms used for the generic "error" state: that one
// is a short label ("Error"), this one is a full sentence
// ("Paste failed — text in clipboard") and needs more time to actually read.
export const PASTE_FAILED_NOTICE_MS = 4000;

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
  (text: string, signal?: AbortSignal): Promise<{
    pasted: boolean;
    clipboardWritten: boolean;
    reason?: string;
    killed?: boolean;
    signal?: string | null;
    code?: string | number | null;
    errorName?: string;
  }>;
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
    // "error", "paste-failed" and "copy-failed" are transient notices being displayed, not
    // work in progress — refusing to start from them would silently eat a
    // push-to-talk press for up to PASTE_FAILED_NOTICE_MS while the pill is
    // still showing a stale message. The guarded auto-return timers for both
    // states already no-op once the state has moved on (see below), so
    // starting a new run out from under a pending notice is safe.
    if (this.state !== "idle" && this.state !== "error" && this.state !== "paste-failed" && this.state !== "copy-failed") return;
    this.cancelled = false;
    this.abortController = new AbortController();
    this.setState("recording");
  }

  cancel(): void {
    if (this.state === "idle") return;
    this.cancelled = true;
    // Abort whatever inject() call may be in flight so a stuck osascript
    // gets killed immediately and the pipeline/overlay un-wedge instead of
    // sitting on "Pasting…" until the 3000ms timeout would eventually have
    // fired on its own. This does NOT guarantee the ⌘V never lands: killing
    // osascript frees us, the sender, but osascript had already handed the
    // Apple Event to System Events' Mach port and was merely blocked
    // waiting for the reply — if System Events was wedged and later
    // recovers, it may still execute that queued keystroke into whatever
    // app is focused by then. Same pre-existing hazard documented at
    // length on PASTE_TIMEOUT_MS in text-injector.ts; this abort is about
    // un-wedging us, not about recalling the event. Harmless no-op if
    // inject hasn't started yet or has already finished.
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
        // so this never reaches the pipeline-failure error path below.
        // A user cancel is expected and not a failure, so it must not be
        // logged as a warning — branch on `cancelled` and log it at info
        // instead, keeping the warn string reserved for a genuine,
        // unprompted paste failure. Either way, pass along the diagnostic
        // fields TextInjector lifted off the error so a log reader can
        // tell a timeout kill (killed/signal set), a cancel abort
        // (errorName "AbortError"), and a silent non-zero exit (neither)
        // apart instead of guessing from the message string.
        const meta = {
          reason: r.reason,
          clipboardWritten: r.clipboardWritten,
          killed: r.killed,
          signal: r.signal,
          code: r.code,
          errorName: r.errorName,
        };
        if (!r.clipboardWritten) {
          // The transcript never reached the clipboard: "text left in
          // clipboard" would be a lie in the log as well as on the overlay.
          if (this.cancelled) {
            await this.deps.logger.info("paste aborted by cancel, text not copied to clipboard", meta);
          } else {
            await this.deps.logger.warn("paste failed, clipboard write failed", meta);
          }
        } else if (this.cancelled) {
          await this.deps.logger.info("paste aborted by cancel, text left in clipboard", meta);
        } else {
          await this.deps.logger.warn("paste failed, text left in clipboard", meta);
        }
      } else if (this.cancelled) {
        // Cancel can also arrive after inject() already resolved
        // pasted=true — e.g. during TextInjector's 500ms post-paste
        // clipboard-restore sleep, which doesn't listen to the abort
        // signal at all. Without this branch that dictation ends with no
        // terminal log line whatsoever: "cleaned" appears and then
        // nothing, which reads in the logs like the pipeline silently
        // died rather than a user cancel that happened to land just after
        // a successful paste.
        await this.deps.logger.info("cancelled after paste completed", { pasted: true });
      }
      if (this.cancelled) {
        this.setState("idle");
        return;
      }
      await this.deps.logger.info("pipeline done", { totalMs: Date.now() - totalStart });
      if (!r.pasted) {
        // A genuine, unprompted paste failure (the cancel case already
        // returned above). Show a transient notice instead of silently
        // dropping back to idle — before this, the failure was invisible
        // and the transcript just sat in the clipboard with no cue at all.
        // If the clipboard write failed too, say so: "text in clipboard"
        // would send the user to paste their OLD clipboard content.
        const failedState: PipelineState = r.clipboardWritten ? "paste-failed" : "copy-failed";
        this.setState(failedState);
        setTimeout(() => {
          if (this.state === failedState) this.setState("idle");
        }, PASTE_FAILED_NOTICE_MS);
      } else {
        this.setState("idle");
      }
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
