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
  /** Watchdog: if a native pass (chunk/final/keepalive) doesn't call back
   *  within this many ms it's treated as a hung whisper_full (a Metal/GPU
   *  stall that holds the inference mutex forever). The runner emits "stall"
   *  and stops scheduling work; the host should relaunch. Default 30000.
   *  Kept well above the worst legitimate cold pass (~11s observed) so a
   *  slow-but-progressing pass is never mistaken for a hang. */
  passTimeoutMs?: number;
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

/** Emitted when a native pass fails to return within passTimeoutMs — a hung
 *  whisper_full (Metal/GPU stall) that holds the single-context inference mutex
 *  forever. The runner cannot recover in-process (init()/release() would block
 *  on that same mutex), so the host should relaunch the app. */
export interface StallInfo {
  phase: PassTiming["phase"];
  timeoutMs: number;
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
  private readonly passTimeoutMs: number;
  private intervalHandle: NodeJS.Timeout | null = null;
  private keepaliveHandle: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private committed = "";
  private currentLanguage = "auto";
  private active = false;
  private cancelled = false;
  private released = false;
  /** Set once a pass is detected as hung. The native context is poisoned (a
   *  worker thread holds the inference mutex forever), so all further native
   *  calls are guarded off and the host is asked to relaunch via "stall". */
  private stalled = false;

  constructor(opts: StreamingWhisperOptions) {
    super();
    this.chunkIntervalMs = opts.chunkIntervalMs ?? 1500;
    this.passTimeoutMs = opts.passTimeoutMs ?? 30000;
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
    if (this.stalled) {
      throw new Error("StreamingWhisperRunner.start() called after a stall (awaiting relaunch)");
    }
    this.native.start();
    this.committed = "";
    this.currentLanguage = language;
    this.active = true;
    this.cancelled = false;
    this.armChunkLoop();
  }

  feedSamples(samples: Float32Array): void {
    if (!this.active || this.released || this.stalled) return;
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
    if (this.released || this.stalled) return "";
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
    // The in-flight chunk may have stalled while we awaited it above — if so the
    // context is poisoned; don't launch the final pass (it would block forever
    // on the held inference mutex). The "stall" event already asked for relaunch.
    if (this.cancelled || this.stalled) return "";
    // Track the final pass in `inFlight` until it settles. The chunk loop is
    // already stopped, but the idle keepalive timer is not — without this guard
    // a keepalive tick during the final pass fires a second whisper_full
    // concurrently on the same context, corrupting ggml's graph allocator
    // (ggml_abort / SIGABRT). With it, runKeepaliveIfIdle sees inFlight and skips.
    const pass = this.runNativePass("final", (cb) => this.native.finalize(language, cb));
    const job = pass.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight = job;
    try {
      const { text, info } = await pass;
      if (info) this.emit("timing", { phase: "final", ...info } as PassTiming);
      return text;
    } finally {
      if (this.inFlight === job) this.inFlight = null;
    }
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

  /**
   * Tear down for app quit WITHOUT calling the blocking native release().
   *
   * The native release() takes the inference mutex to free the model safely —
   * but a hung whisper_full pass holds that mutex forever, so calling release()
   * on quit blocks the main thread indefinitely and the app can never quit
   * (force-quit territory). At process exit the OS reclaims the model and GPU
   * anyway, so we just stop our timers and let the process die. Use this on
   * `will-quit`; use release() only for a graceful, non-quit teardown.
   */
  shutdown(): void {
    this.stopChunkLoop();
    if (this.keepaliveHandle) {
      clearInterval(this.keepaliveHandle);
      this.keepaliveHandle = null;
    }
    this.active = false;
    this.released = true;
  }

  /**
   * Invoke a native pass and resolve when its callback fires. If the callback
   * does not arrive within passTimeoutMs the pass is treated as hung — a
   * whisper_full / Metal stall that holds the inference mutex forever — so we
   * raise a stall and reject. A callback that arrives after the timeout is
   * ignored (its worker thread is wedged; we've already moved on / relaunched).
   */
  private runNativePass(
    phase: PassTiming["phase"],
    arm: (cb: NativeCb) => void,
  ): Promise<{ text: string; info?: PassInfo }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.onStall(phase);
        reject(new Error(`whisper ${phase} pass timed out after ${this.passTimeoutMs}ms`));
      }, this.passTimeoutMs);
      arm((err, text, info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ text, info });
      });
    });
  }

  /** A native pass hung. The worker thread is stuck inside whisper_full holding
   *  the inference mutex; we can't recover in-process (init/release would block
   *  on it too). Stop all scheduling and signal the host to relaunch. */
  private onStall(phase: PassTiming["phase"]): void {
    if (this.stalled) return;
    this.stalled = true;
    this.active = false;
    this.stopChunkLoop();
    if (this.keepaliveHandle) {
      clearInterval(this.keepaliveHandle);
      this.keepaliveHandle = null;
    }
    this.emit("stall", { phase, timeoutMs: this.passTimeoutMs } as StallInfo);
  }

  /** Run a GPU-warming pass, but only when idle: never while recording (the
   *  chunk loop already exercises the GPU) and never while another inference
   *  is in flight (whisper_full must stay serialized on the single context).
   *  Shares the `inFlight` guard with runChunkIfIdle, so the two are mutually
   *  exclusive. */
  private async runKeepaliveIfIdle(): Promise<void> {
    if (this.released || this.active || this.inFlight || this.stalled) return;
    const job = this.runNativePass("keepalive", (cb) => this.native.keepalive(cb))
      .then(({ info }) => {
        if (info) this.emit("timing", { phase: "keepalive", ...info } as PassTiming);
      })
      .catch(() => undefined); // stall already handled in onStall; don't reject the timer loop
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
    if (!this.active || this.cancelled || this.released || this.stalled) return;
    if (this.inFlight) return;
    const language = this.currentLanguage;
    const job = this.runNativePass("chunk", (cb) => this.native.processChunk(language, cb))
      .then(({ text, info }) => {
        if (info) this.emit("timing", { phase: "chunk", ...info } as PassTiming);
        if (!this.cancelled && this.active) {
          this.applyChunkText(text);
        }
      })
      .catch(() => undefined); // stall already handled in onStall; don't reject the timer loop
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
