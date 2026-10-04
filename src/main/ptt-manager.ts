import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { join } from "node:path";

/** States the native monitor reports. "DESYNC" is purely diagnostic: it means
 *  the addon's cached Option state disagreed with the live modifier flags, i.e.
 *  a flagsChanged edge was dropped (an NSEvent global monitor never sees events
 *  routed to our own windows, nor anything while Secure Input is engaged). */
export type NativePttState = "DOWN" | "UP" | "CHORD" | "DESYNC";

interface NativePttModule {
  start: (cb: (state: NativePttState, detail?: string) => void) => boolean;
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
  appRoot?: string;
  /** Whether the app is running from a packaged .app bundle. */
  isPackaged?: boolean;
  /** Minimum hold duration to count as PTT vs accidental tap (ms). */
  minHoldMs?: number;
  /** Injected native addon, for tests. Defaults to loading the built .node
   *  from appRoot. When provided, appRoot/isPackaged are unused. */
  native?: NativePttModule;
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
 *   - 'rawEvent' (state, detail) for every native event, diagnostics included
 */
export class PTTManager extends EventEmitter {
  private readonly native: NativePttModule;
  private readonly minHoldMs: number;
  private running = false;
  private heldSince: number | null = null;
  private startEmitted = false;
  private chordActive = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(opts: PTTManagerOptions) {
    super();
    this.minHoldMs = opts.minHoldMs ?? 150;
    this.native =
      opts.native ?? loadNativeAddon(opts.appRoot ?? "", opts.isPackaged ?? false);
  }

  /** Returns true when the monitor is installed (or already was), false when trust is missing. */
  start(): boolean {
    if (this.running) return true;
    if (!this.native.isTrusted()) {
      // Trigger the macOS prompt (shows the standard "open Settings" dialog).
      this.native.requestTrust();
      this.emit("trustRequired");
      return false;
    }
    const installed = this.native.start((state, detail) => this.handleState(state, detail));
    if (!installed) {
      this.emit("trustRequired");
      return false;
    }
    this.running = true;
    this.emit("ready");
    return true;
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

  /** Asks macOS for Accessibility (shows the system prompt and lists the app in System Settings). */
  requestTrust(): boolean {
    return this.native.requestTrust();
  }

  private handleState(state: NativePttState, detail?: string): void {
    this.emit("rawEvent", state, detail);
    // Observation only — a dropped-edge report must never arm, start or cancel
    // a gesture, so it stops here before touching the state machine.
    if (state === "DESYNC") return;
    if (state === "DOWN") {
      if (this.heldSince !== null) return;
      this.heldSince = Date.now();
      this.startEmitted = false;
      this.chordActive = false;
      this.emit("arm");
      this.holdTimer = setTimeout(() => {
        // Don't fire 'start' if the user has already combined Option with
        // another key — they're using it as a shortcut modifier, not PTT.
        if (this.chordActive) return;
        this.startEmitted = true;
        this.emit("start");
      }, this.minHoldMs);
    } else if (state === "CHORD") {
      if (this.heldSince === null) return;
      // A non-modifier key fired while Option was held → not a PTT gesture.
      // Cancel any pending start and, if start already fired, send a cancel
      // so the host stops the mic and discards audio.
      this.clearHoldTimer();
      if (this.chordActive) return;
      this.chordActive = true;
      if (this.startEmitted) {
        this.emit("cancel");
        this.startEmitted = false;
      } else {
        this.emit("cancel");
      }
    } else if (state === "UP") {
      if (this.heldSince === null) return;
      const wasChord = this.chordActive;
      this.heldSince = null;
      this.chordActive = false;
      this.clearHoldTimer();
      if (wasChord) {
        // Already cancelled on the CHORD event; nothing else to emit.
        return;
      }
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
