import { Tray, Menu, app, nativeImage } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export interface MenubarCallbacks {
  onToggleEnabled: () => void;
  onOpenSettings: () => void;
  onCheckPermissions: () => void;
  onOpenLogs: () => void;
  onRelaunch: () => void;
  onQuit: () => void;
}

export interface MenubarOptions {
  /** Shown in the first (disabled) menu line, e.g. "open-flow 0.2.3 — Ready". */
  version: string;
}

export class MenubarApp {
  private tray: Tray | null = null;
  private enabled = true;
  private currentStatus = "Starting…";
  private permissionHint: string | null = null;

  constructor(
    private readonly callbacks: MenubarCallbacks,
    private readonly options: MenubarOptions,
  ) {}

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

  /** Extra disabled line under the status, e.g. "Accessibility permission needed". */
  setPermissionHint(hint: string | null): void {
    this.permissionHint = hint;
    this.refreshMenu();
  }

  private refreshMenu(): void {
    if (!this.tray) return;
    const status = this.enabled ? this.currentStatus : "Paused";
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: `open-flow ${this.options.version} — ${status}`, enabled: false },
    ];
    if (this.permissionHint) {
      template.push({ label: this.permissionHint, enabled: false });
    }
    template.push(
      { type: "separator" },
      {
        label: this.enabled ? "Pause dictation" : "Resume dictation",
        click: () => {
          this.enabled = !this.enabled;
          this.callbacks.onToggleEnabled();
          this.refreshMenu();
        },
      },
      { label: "Settings…", click: () => this.callbacks.onOpenSettings() },
      { type: "separator" },
      { label: "Check permissions…", click: () => this.callbacks.onCheckPermissions() },
      { label: "Open Logs", click: () => this.callbacks.onOpenLogs() },
      { label: "Relaunch open-flow", click: () => this.callbacks.onRelaunch() },
      { type: "separator" },
      { label: "Quit open-flow", click: () => this.callbacks.onQuit() },
    );
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
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
