import { BrowserWindow, screen } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export class OverlayWindow {
  private win: BrowserWindow | null = null;

  async create(): Promise<void> {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const w = 360;
    const h = 80;
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
      focusable: false,
      show: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "overlay-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
