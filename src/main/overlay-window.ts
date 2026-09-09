import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IpcChannels } from "../shared/ipc-channels.js";
import type { SuggestionPayload } from "../shared/reply-types.js";
import { computeOverlayBounds, PILL_WINDOW_SIZE, SUGGEST_WINDOW_SIZE, type Size } from "./utils/overlay-bounds.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export class OverlayWindow {
  private win: BrowserWindow | null = null;
  /** Current window size; `show()` re-centers at this size. */
  private size: Size = { ...PILL_WINDOW_SIZE };

  async create(): Promise<void> {
    // Window is larger than the visible pill so the box-shadow (which
    // extends ~24px out from each edge) has room to render without being
    // clipped by the window boundary. The pill itself is centered inside
    // via CSS flexbox + padding.
    const b = this.currentBounds();
    this.win = new BrowserWindow({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: false,
      skipTaskbar: true,
      // focusable: true so mouse clicks on ✕ register, but acceptFirstMouse
      // lets the user click without first activating the app.
      focusable: true,
      acceptFirstMouse: true,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Float above other windows including fullscreen apps, but don't steal
    // focus when shown via showInactive().
    this.win.setAlwaysOnTop(true, "floating");
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "overlay.html"));
  }

  /** Fresh bounds for the CURRENT cursor position and window size. Called at
   *  every show(): the user changes monitor between one dictation and the next. */
  private currentBounds(): { x: number; y: number; width: number; height: number } {
    return computeOverlayBounds(screen.getAllDisplays(), screen.getCursorScreenPoint(), this.size);
  }

  private reposition(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const { x, y, width, height } = this.currentBounds();
    this.win.setBounds({ x, y, width, height });
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.reposition();
    this.win.showInactive(); // never steal focus: the paste must land in the target app
  }

  hide(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.hide();
    this.resetSize(); // the next dictation pill must not be 480×300
  }

  /** Enters the suggesting state: grows the window, sends the payload, shows. */
  showSuggestions(payload: SuggestionPayload): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.size = { ...SUGGEST_WINDOW_SIZE };
    this.win.webContents.send(IpcChannels.ReplySuggestions, payload);
    this.sendState("suggesting");
    this.show();
  }

  /** Back to the pill geometry, repositioning if the window is still visible. */
  resetSize(): void {
    this.size = { ...PILL_WINDOW_SIZE };
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.reposition();
  }

  /** Neutral one-line message (degradation L2/L3). The text comes from the
   *  coordinator's fixed table — never a code that describes the screen. */
  sendFlash(text: string): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send(IpcChannels.ReplyFlash, text);
    this.sendState("flash");
    this.show();
  }

  sendState(state: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IpcChannels.PipelineStateChange, state);
    }
  }

  sendPartial(text: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("pipeline:partial-transcript", text);
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
      this.win = null;
    }
  }
}
