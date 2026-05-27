import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Per-pass timing/abort diagnostics reported by the native addon. queueMs
 *  (time spent waiting for a libuv worker thread) vs execMs (time actually
 *  running inference) distinguish threadpool starvation from a slow pass. */
export interface PassInfo {
  queueMs: number;
  execMs: number;
  aborted: boolean;
}

type NativeCb = (err: Error | null, text: string, info?: PassInfo) => void;

interface NativeWhisperStream {
  init: (modelPath: string) => boolean;
  start: () => void;
  feedSamples: (samples: Float32Array) => void;
  processChunk: (language: string, cb: NativeCb) => void;
  /** Raise the cooperative abort flag so an in-flight processChunk returns
   *  early. The host calls this before finalize() — see finalize(). */
  requestAbort: () => void;
  finalize: (language: string, cb: NativeCb) => void;
  /** Run a short pass on silence to keep the Metal pipeline / GPU clocks warm
   *  while idle. Serialized with processChunk/finalize by the host. */
  keepalive: (cb: NativeCb) => void;
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
  appRoot?: string;
  isPackaged?: boolean;
  modelPath: string;
  /** How often to run processChunk while recording (ms). Default 1500. */
  chunkIntervalMs?: number;
  /** How often to run a keepalive pass while idle (ms) to keep the GPU warm.
   *  0 disables. Default 0. */
  keepaliveIntervalMs?: number;
  /** Injected native addon, for tests. Defaults to loading the built .node
   *  from appRoot. When provided, appRoot/isPackaged are unused. */
  native?: NativeWhisperStream;
}

/** Emitted after every inference pass with native timing. `phase` is "chunk"
 *  for streaming passes, "final" for the finalize pass, "keepalive" for the
 *  idle GPU-warming pass. */
export interface PassTiming extends PassInfo {
  phase: "chunk" | "final" | "keepalive";
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
  private keepaliveHandle: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private committed = "";
  private currentLanguage = "auto";
  private active = false;
  private cancelled = false;
  private released = false;

  constructor(opts: StreamingWhisperOptions) {
    super();
    this.chunkIntervalMs = opts.chunkIntervalMs ?? 1500;
    this.native = opts.native ?? loadNativeAddon(opts.appRoot ?? "", opts.isPackaged ?? false);
    const ok = this.native.init(opts.modelPath);
    if (!ok) {
      throw new Error(`whisper_stream init failed for ${opts.modelPath}`);
    }
    const keepaliveMs = opts.keepaliveIntervalMs ?? 0;
    if (keepaliveMs > 0) {
      this.keepaliveHandle = setInterval(() => {
        void this.runKeepaliveIfIdle();
      }, keepaliveMs);
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
      // The in-flight streaming chunk's result is discarded by the final pass
      // anyway, so abort it rather than awaiting it to completion — otherwise a
      // single slow chunk gates the entire transcript latency. The abort flag
      // is cleared native-side before the final pass, so the two stay strictly
      // serialized (whisper_full is not thread-safe on one context).
      this.native.requestAbort();
      await this.inFlight.catch(() => undefined);
    }
    this.active = false;
    if (this.cancelled) return "";
    return new Promise<string>((resolve, reject) => {
      this.native.finalize(language, (err, text, info) => {
        if (err) {
          reject(err);
          return;
        }
        if (info) this.emit("timing", { phase: "final", ...info } as PassTiming);
        resolve(text);
      });
    });
  }

  release(): void {
    this.stopChunkLoop();
    if (this.keepaliveHandle) {
      clearInterval(this.keepaliveHandle);
      this.keepaliveHandle = null;
    }
    this.active = false;
    this.released = true;
    this.native.release();
  }

  /** Run a GPU-warming pass, but only when idle: never while recording (the
   *  chunk loop already exercises the GPU) and never while another inference
   *  is in flight (whisper_full must stay serialized on the single context).
   *  Shares the `inFlight` guard with runChunkIfIdle, so the two are mutually
   *  exclusive. */
  private async runKeepaliveIfIdle(): Promise<void> {
    if (this.released || this.active || this.inFlight) return;
    const job = new Promise<void>((resolve) => {
      this.native.keepalive((_err, _text, info) => {
        if (info) this.emit("timing", { phase: "keepalive", ...info } as PassTiming);
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
      this.native.processChunk(language, (err, text, info) => {
        if (info) this.emit("timing", { phase: "chunk", ...info } as PassTiming);
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
