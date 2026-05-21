import { EventEmitter } from "node:events";
import { uIOhook } from "uiohook-napi";

// macOS kVK_RightOption raw keycode (CGKeyCode value)
const MACOS_RIGHT_OPTION_RAWCODE = 61;
const MACOS_LEFT_OPTION_RAWCODE = 58;

export interface PTTManagerOptions {
  /**
   * Which keys (by macOS rawcode) trigger PTT. Default: both Option keys.
   * Holding either Option = recording.
   */
  keyRawcodes?: number[];
  /** Minimum hold duration to count as PTT vs accidental tap (ms). */
  minHoldMs?: number;
}

/**
 * Push-to-talk hotkey manager using uiohook-napi to capture global keydown/keyup
 * events for any key — including modifier keys alone, which Electron's
 * globalShortcut cannot bind to.
 *
 * Emits:
 *   - 'start'  when the PTT key is pressed (and held past minHoldMs)
 *   - 'stop'   when the PTT key is released after a successful 'start'
 *   - 'cancel' if the user releases before minHoldMs (treated as accidental tap)
 *
 * Requires macOS Accessibility AND Input Monitoring permissions. uiohook-napi
 * prompts on first use.
 */
export class PTTManager extends EventEmitter {
  private readonly keyRawcodes: Set<number>;
  private readonly minHoldMs: number;
  private started = false;
  private heldSince: number | null = null;
  private startEmitted = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(opts: PTTManagerOptions = {}) {
    super();
    this.keyRawcodes = new Set(
      opts.keyRawcodes ?? [MACOS_RIGHT_OPTION_RAWCODE, MACOS_LEFT_OPTION_RAWCODE],
    );
    this.minHoldMs = opts.minHoldMs ?? 150;
  }

  start(): void {
    if (this.started) return;

    uIOhook.on("keydown", (e) => {
      const rawcode = (e as unknown as { rawcode: number }).rawcode;
      if (!this.keyRawcodes.has(rawcode)) return;
      // Repeat events fire continuously while the key is held; only act on
      // the first keydown (heldSince null means we're not already holding).
      if (this.heldSince !== null) return;
      this.heldSince = Date.now();
      this.startEmitted = false;
      this.holdTimer = setTimeout(() => {
        this.startEmitted = true;
        this.emit("start");
      }, this.minHoldMs);
    });

    uIOhook.on("keyup", (e) => {
      const rawcode = (e as unknown as { rawcode: number }).rawcode;
      if (!this.keyRawcodes.has(rawcode)) return;
      if (this.heldSince === null) return;
      this.heldSince = null;
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      if (this.startEmitted) {
        this.emit("stop");
        this.startEmitted = false;
      } else {
        this.emit("cancel");
      }
    });

    uIOhook.start();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    uIOhook.stop();
    this.removeAllListeners();
    this.started = false;
    this.heldSince = null;
    this.startEmitted = false;
  }
}
