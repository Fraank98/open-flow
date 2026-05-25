import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export class OverlayWindow {
  private win: BrowserWindow | null = null;

  async create(): Promise<void> {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    // Window is larger than the visible pill so the box-shadow (which
    // extends ~24px out from each edge) has room to render without being
    // clipped by the window boundary. The pill itself is centered inside
    // via CSS flexbox + padding.
    const w = 420;
    const h = 124;
    this.win = new BrowserWindow({
      width: w,
      height: h,
      x: Math.floor((width - w) / 2),
      y: height - h - 24,
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

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.hide();
    }
  }

  sendState(state: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("pipeline:state-change", state);
    }
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
      this.win = null;
    }
  }
}
