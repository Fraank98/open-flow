import { normalizePillStyle, pillWindowSize, type PillStyle } from "./utils/pill-style.js";
import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IpcChannels } from "../shared/ipc-channels.js";
import type { SuggestionPayload } from "../shared/reply-types.js";
import { computeOverlayBounds, type Size, type Rect } from "./utils/overlay-bounds.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export class OverlayWindow {
  private win: BrowserWindow | null = null;
  private bounds: Rect | null = null;
  /** Current window size; `show()` re-centers at this size. */
  private state = "idle";
  private style: PillStyle = "compact";
  private shortcutLabel = "⌥ Option";
  private size: Size = pillWindowSize(this.style, this.state);

  setAppearance(style: PillStyle, shortcutLabel: string): void {
    this.style = normalizePillStyle(style);
    this.shortcutLabel = shortcutLabel;
    this.size = pillWindowSize(this.style, this.state);
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send("overlay:appearance", { style: this.style, shortcutLabel });
    if (this.win.isVisible()) this.reposition();
  }

  sendLevel(level: number): void {
    if (this.state === "recording" && this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("overlay:level", level);
    }
  }

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
    this.setAppearance(this.style, this.shortcutLabel);
  }

  /** Re-evaluate the display when opening a new overlay session. */
  private currentBounds(): { x: number; y: number; width: number; height: number } {
    return computeOverlayBounds(screen.getAllDisplays(), screen.getCursorScreenPoint(), this.size);
  }

  private reposition(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const previous = this.bounds;
    // Keep one bottom-center anchor while visible. macOS can change the
    // work area (Dock/fullscreen), and the cursor can move between displays
    // while recording. Neither should move an in-progress dictation.
    if (this.win.isVisible() && previous && previous.width === this.size.width && previous.height === this.size.height) return;
    const next = this.win.isVisible() && previous
      ? { x: Math.round(previous.x + (previous.width - this.size.width) / 2),
          y: previous.y + previous.height - this.size.height, ...this.size }
      : this.currentBounds();
    const { x, y, width, height } = next;
    this.bounds = { x, y, width, height };
    this.win.setBounds(this.bounds);
  }

  show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible()) return;
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
    this.size = pillWindowSize(this.style, "suggesting");
    this.win.webContents.send(IpcChannels.ReplySuggestions, payload);
    this.sendState("suggesting");
    this.show();
  }

  /** Back to the pill geometry, repositioning if the window is still visible. */
  resetSize(): void {
    this.state = "idle";
    this.size = pillWindowSize(this.style, this.state);
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
    this.state = state;
    this.size = pillWindowSize(this.style, state);
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.reposition();
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
