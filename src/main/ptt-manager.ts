import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface NativePttModule {
  start: (cb: (state: "DOWN" | "UP") => void) => boolean;
  stop: () => void;
  isTrusted: () => boolean;
  requestTrust: () => boolean;
}

function loadNativeAddon(appRoot: string, isPackaged: boolean): NativePttModule {
  // In packaged builds, the .node file lives at app.asar.unpacked/build/Release/.
  // In dev, at <repo>/build/Release/. We resolve both via createRequire so the
  // native module is loaded with the right module-search semantics under ESM.
  const require_ = createRequire(import.meta.url);
  const candidates = isPackaged
    ? [
        join(appRoot, "..", "app.asar.unpacked", "build", "Release", "ptt_monitor.node"),
        join(appRoot, "build", "Release", "ptt_monitor.node"),
      ]
    : [join(appRoot, "build", "Release", "ptt_monitor.node")];
  let lastErr: unknown = null;
  for (const path of candidates) {
    try {
      return require_(path) as NativePttModule;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not load ptt_monitor.node. Tried: ${candidates.join(", ")}. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

export interface PTTManagerOptions {
  /** Repo root (for dev) or asar root (for packaged). Used to resolve the native addon. */
  appRoot: string;
  /** Whether the app is running from a packaged .app bundle. */
  isPackaged: boolean;
  /** Minimum hold duration to count as PTT vs accidental tap (ms). */
  minHoldMs?: number;
}

/**
 * Push-to-talk manager using an in-process Native Node addon (Objective-C++)
 * that wraps NSEvent.addGlobalMonitorForEvents on .flagsChanged events.
 *
 * Because the monitor runs in the Electron main process itself (not a spawned
 * child binary), macOS TCC sees a single Accessibility entry — same UX as
 * Wispr Flow and similar dictation apps. No Input Monitoring required.
 *
 * Emits:
 *   - 'start'  when Option is held past minHoldMs
 *   - 'stop'   when Option is released after a successful 'start'
 *   - 'cancel' if the user releases before minHoldMs (accidental tap)
 *   - 'trustRequired' if Accessibility is not granted
 *   - 'ready'  after the monitor is armed
 */
export class PTTManager extends EventEmitter {
  private readonly native: NativePttModule;
  private readonly minHoldMs: number;
  private running = false;
  private heldSince: number | null = null;
  private startEmitted = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(opts: PTTManagerOptions) {
    super();
    this.minHoldMs = opts.minHoldMs ?? 150;
    this.native = loadNativeAddon(opts.appRoot, opts.isPackaged);
  }

  start(): void {
    if (this.running) return;
    if (!this.native.isTrusted()) {
      // Trigger the macOS prompt (shows the standard "open Settings" dialog).
      this.native.requestTrust();
      this.emit("trustRequired");
      return;
    }
    const installed = this.native.start((state) => this.handleState(state));
    if (!installed) {
      this.emit("trustRequired");
      return;
    }
    this.running = true;
    this.emit("ready");
  }

  stop(): void {
    if (!this.running) return;
    this.native.stop();
    this.clearHoldTimer();
    this.heldSince = null;
    this.startEmitted = false;
    this.running = false;
  }

  isTrusted(): boolean {
    return this.native.isTrusted();
  }

  private handleState(state: "DOWN" | "UP"): void {
    if (state === "DOWN") {
      if (this.heldSince !== null) return;
      this.heldSince = Date.now();
      this.startEmitted = false;
      // Emit 'arm' immediately so the host can start capturing audio NOW,
      // before the debounce. Otherwise we lose the first 150ms of speech.
      this.emit("arm");
      this.holdTimer = setTimeout(() => {
        this.startEmitted = true;
        this.emit("start");
      }, this.minHoldMs);
    } else if (state === "UP") {
      if (this.heldSince === null) return;
      this.heldSince = null;
      this.clearHoldTimer();
      if (this.startEmitted) {
        this.emit("stop");
        this.startEmitted = false;
      } else {
        this.emit("cancel");
      }
    }
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
