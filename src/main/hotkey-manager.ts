import { globalShortcut } from "electron";
import { EventEmitter } from "node:events";

export interface HotkeyManagerOptions {
  accelerator: string;
}

export class HotkeyManager extends EventEmitter {
  private active = false;
  private registered = false;

  constructor(private readonly opts: HotkeyManagerOptions) {
    super();
  }

  register(): { ok: true } | { ok: false; reason: string } {
    const ok = globalShortcut.register(this.opts.accelerator, () => {
      this.active = !this.active;
      if (this.active) {
        this.emit("start");
      } else {
        this.emit("stop");
      }
    });
    if (!ok) {
      return { ok: false, reason: `Could not register hotkey ${this.opts.accelerator}` };
    }
    this.registered = true;
    return { ok: true };
  }

  unregister(): void {
    if (!this.registered) return;
    globalShortcut.unregister(this.opts.accelerator);
    this.registered = false;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Force the manager back to inactive without firing 'stop'. Used after the
   * pipeline auto-completes (e.g., audio fully transcribed); the next hotkey
   * press should be treated as a fresh "start".
   */
  reset(): void {
    this.active = false;
  }
}
