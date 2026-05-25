import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";

interface NativeWhisperStream {
  init: (modelPath: string) => boolean;
  start: () => void;
  feedSamples: (samples: Float32Array) => void;
  processChunk: (language: string, cb: (err: Error | null, text: string) => void) => void;
  finalize: (language: string, cb: (err: Error | null, text: string) => void) => void;
  release: () => void;
}

function loadNativeAddon(appRoot: string, isPackaged: boolean): NativeWhisperStream {
  const require_ = createRequire(import.meta.url);
  const candidates = isPackaged
    ? [
        join(appRoot, "..", "app.asar.unpacked", "build", "Release", "whisper_stream.node"),
        join(appRoot, "build", "Release", "whisper_stream.node"),
      ]
    : [join(appRoot, "build", "Release", "whisper_stream.node")];
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      return require_(path) as NativeWhisperStream;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not load whisper_stream.node. Tried: ${candidates.join(", ")}. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface StreamingWhisperOptions {
  appRoot: string;
  isPackaged: boolean;
  modelPath: string;
  /** How often to run processChunk while recording (ms). Default 1500. */
  chunkIntervalMs?: number;
}

export interface PartialTranscript {
  /** The complete transcript-so-far from the latest inference pass. */
  full: string;
  /** The portion of `full` that wasn't present in the previously-committed
   *  text — useful for incremental live-preview rendering. */
  newSuffix: string;
}

/**
 * Streaming wrapper around the whisper_stream native addon.
 *
 * Lifecycle of one utterance:
 *
 *   runner.start("it");               // reset native buffer + arm interval
 *   runner.feedSamples(chunk1);
 *   runner.feedSamples(chunk2);
 *   ... (host keeps pushing chunks from the recorder)
 *   // every chunkIntervalMs an inference fires automatically. If a previous
 *   // one is still in flight the tick is skipped (no concurrent calls).
 *   // 'partial' events fire after each successful inference.
 *   const final = await runner.finalize("it");  // awaits the last in-flight
 *
 * Race-safety contract:
 *   - feedSamples can be called at any time, including during inference (the
 *     native side serializes via a mutex on the sample buffer).
 *   - processChunk and finalize NEVER overlap on the same context. The host
 *     should not call start() again until release() or finalize() resolves.
 *   - cancel() invalidates any in-flight inference's result — the host
 *     should not pipe partials emitted after cancel() to the UI.
 */
export class StreamingWhisperRunner extends EventEmitter {
  private readonly native: NativeWhisperStream;
  private readonly chunkIntervalMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private committed = "";
  private currentLanguage = "auto";
  private active = false;
  private cancelled = false;
  private released = false;

  constructor(opts: StreamingWhisperOptions) {
    super();
    this.chunkIntervalMs = opts.chunkIntervalMs ?? 1500;
    this.native = loadNativeAddon(opts.appRoot, opts.isPackaged);
    const ok = this.native.init(opts.modelPath);
    if (!ok) {
      throw new Error(`whisper_stream init failed for ${opts.modelPath}`);
    }
  }

  start(language: string): void {
    if (this.released) {
      throw new Error("StreamingWhisperRunner.start() called after release()");
    }
    this.native.start();
    this.committed = "";
    this.currentLanguage = language;
    this.active = true;
    this.cancelled = false;
    this.armChunkLoop();
  }

  feedSamples(samples: Float32Array): void {
    if (!this.active || this.released) return;
    this.native.feedSamples(samples);
  }

  /** Discard the current utterance. Stops the chunk loop. Any in-flight
   *  inference's result is suppressed via the `cancelled` flag. */
  cancel(): void {
    this.cancelled = true;
    this.active = false;
    this.stopChunkLoop();
    this.committed = "";
  }

  /** Stop the chunk loop, wait for any in-flight tick to settle, then run
   *  one final inference pass and return the final text. After resolving,
   *  the runner is ready for another start(). */
  async finalize(language: string): Promise<string> {
    if (this.released) return "";
    this.currentLanguage = language;
    this.stopChunkLoop();
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
    this.active = false;
    if (this.cancelled) return "";
    return new Promise<string>((resolve, reject) => {
      this.native.finalize(language, (err, text) => {
        if (err) reject(err);
        else resolve(text);
      });
    });
  }

  release(): void {
    this.stopChunkLoop();
    this.active = false;
    this.released = true;
    this.native.release();
  }

  private armChunkLoop(): void {
    this.stopChunkLoop();
    this.intervalHandle = setInterval(() => {
      void this.runChunkIfIdle();
    }, this.chunkIntervalMs);
  }

  private stopChunkLoop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  private async runChunkIfIdle(): Promise<void> {
    if (!this.active || this.cancelled || this.released) return;
    if (this.inFlight) return;
    const language = this.currentLanguage;
    const job = new Promise<void>((resolve) => {
      this.native.processChunk(language, (err, text) => {
        if (!err && !this.cancelled && this.active) {
          this.applyChunkText(text);
        }
        resolve();
      });
    });
    this.inFlight = job;
    try {
      await job;
    } finally {
      if (this.inFlight === job) this.inFlight = null;
    }
  }

  private applyChunkText(text: string): void {
    if (!text || text === this.committed) return;
    const newSuffix = computeNewSuffix(this.committed, text);
    this.committed = text;
    this.emit("partial", { full: text, newSuffix } as PartialTranscript);
  }
}

/**
 * Returns the portion of `current` that wasn't already in `committed`,
 * compared word-by-word (case-insensitive). Returns "" if every word in
 * current was already committed. The dedup is word-level not char-level
 * because Whisper occasionally changes its mind about word boundaries
 * between passes ("non ne ho" vs "non n'ho") and a char-diff would
 * over-report changes.
 */
export function computeNewSuffix(committed: string, current: string): string {
  if (!committed) return current.trim();
  const a = committed.trim().split(/\s+/).filter(Boolean);
  const b = current.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.toLowerCase() === b[i]!.toLowerCase()) {
    i++;
  }
  return b.slice(i).join(" ");
}
