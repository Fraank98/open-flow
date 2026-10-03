import { Tray, Menu, app, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export interface MenubarCallbacks {
  onToggleEnabled: () => void;
  onOpenPreferences: () => void;
  onQuit: () => void;
}

export class MenubarApp {
  private tray: Tray | null = null;
  private enabled = true;
  private currentStatus = "Starting…";

  constructor(private readonly callbacks: MenubarCallbacks) {}

  create(): void {
    const iconPath = join(APP_ROOT, "resources", "icons", "tray-template.png");
    const icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("open-flow");
    this.refreshMenu();

    // Hide dock icon — this is a menubar app
    app.dock?.hide();
  }

  setStatus(status: string): void {
    this.currentStatus = status;
    this.refreshMenu();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: `open-flow — ${this.currentStatus}`, enabled: false },
      { type: "separator" },
      {
        label: this.enabled ? "Disable hotkey" : "Enable hotkey",
        click: () => {
          this.enabled = !this.enabled;
          this.callbacks.onToggleEnabled();
          this.refreshMenu();
        },
      },
      { label: "Preferences…", click: () => this.callbacks.onOpenPreferences() },
      { type: "separator" },
      { label: "Quit open-flow", click: () => this.callbacks.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
