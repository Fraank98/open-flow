import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS } from "./model-catalog.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import { downloadErrorText } from "./utils/download-errors.js";
import { createEmitGate } from "./utils/emit-gate.js";
import { DownloadTracker } from "./utils/download-tracker.js";
import { sanitizePrefsPatch } from "./utils/prefs-patch.js";
import { getModelsDir } from "./utils/model-paths.js";
import type { PermissionStatus } from "./permissions.js";
import type { CatalogModel } from "./model-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const SETTINGS_PANES: Record<string, string> = {
  accessibility: "Privacy_Accessibility",
  microphone: "Privacy_Microphone",
  automation: "Privacy_Automation",
};

/** Same backgrounds as lib/theme.css, so the window never flashes the wrong colour. */
const BG_LIGHT = "#f5f5f7";
const BG_DARK = "#1e1e1e";

const APP_ROOT = join(dirname(__filename), "..", "..");

const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "it", label: "Italiano" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
];

async function describeModel(manager: ModelManager, tracker: DownloadTracker, m: CatalogModel) {
  const progress = tracker.progress(m.id);
  return {
    id: m.id,
    label: m.label,
    description: m.description,
    sizeBytes: m.sizeBytes,
    ramBytes: m.ramBytes,
    installed: await manager.isInstalled(m),
    licenseNote: m.licenseNote,
    // A download may be running from before this window was (re)opened: the card
    // reopens in its progress state instead of offering Download again.
    downloading: tracker.isActive(m.id),
    progress,
  };
}

export interface PermissionsSnapshot {
  mic: PermissionStatus;
  accessibility: PermissionStatus;
  automation: PermissionStatus;
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
  /** Restart-required fields that differ from the prefs the app booted with. */
  restartStatus: () => Promise<string[]>;
  /** Current permissions; `probeAutomation` runs the osascript probe (it can raise the macOS prompt). */
  permissionsStatus: (probeAutomation: boolean) => Promise<PermissionsSnapshot>;
  logDir: string;
  version: string;
}

export class PreferencesWindow {
  private win: BrowserWindow | null = null;
  private handlersRegistered = false;
  private readonly savedListeners: Array<(prefs: Preferences) => void> = [];
  /** Downloads in flight, by model id: Cancel aborts them and a reopened window re-attaches to them. */
  private readonly downloads = new DownloadTracker();
  /** Serialises read-modify-write updates so quick successive toggles never clobber each other. */
  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PreferencesWindowDeps) {}

  /** Register a listener called after every successful save with the saved prefs. */
  onSaved(cb: (prefs: Preferences) => void): void {
    this.savedListeners.push(cb);
  }

  /** Opens the window, optionally on a tab ("general", "dictation", "models", "advanced"). */
  async open(tab?: string): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
      if (tab) this.win.webContents.send("prefs:show-tab", tab);
      return;
    }
    const win = new BrowserWindow({
      width: 640,
      height: 600,
      minWidth: 560,
      minHeight: 480,
      title: "open-flow Settings",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT,
      resizable: true,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "preferences-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win = win;
    win.once("ready-to-show", () => win.show());
    this.registerHandlers();
    win.on("closed", () => {
      // Closing the window leaves downloads running; their progress just has no listener.
      if (this.win === win) this.win = null;
    });
    await win.loadFile(join(APP_ROOT, "src", "renderer", "preferences.html"), tab ? { hash: tab } : undefined);
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  private applyUpdate(rawPatch: unknown): Promise<Preferences> {
    const run = async (): Promise<Preferences> => {
      const patch = sanitizePrefsPatch(rawPatch);
      const next = await this.deps.preferencesStore.update(patch);
      // Apply launch-at-login immediately so the user sees feedback in
      // System Settings → General → Login Items without restarting.
      if (patch.launchAtLogin !== undefined) {
        try {
          if (app.getLoginItemSettings().openAtLogin !== next.launchAtLogin) {
            app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
          }
        } catch {
          // ignore — pref is saved, will be re-applied on next launch
        }
      }
      for (const cb of this.savedListeners) {
        try {
          cb(next);
        } catch {
          // a misbehaving listener must not fail the save
        }
      }
      return next;
    };
    const result = this.updateQueue.then(run, run);
    this.updateQueue = result.catch(() => undefined);
    return result;
  }

  private registerHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    ipcMain.handle("prefs:load", async (): Promise<Preferences> => {
      return this.deps.preferencesStore.load();
    });

    // Autosave: every control sends just the fields it changed.
    ipcMain.handle("prefs:update", (_e, patch: unknown): Promise<Preferences> => this.applyUpdate(patch));

    ipcMain.handle("prefs:restart-status", async (): Promise<{ fields: string[] }> => ({
      fields: await this.deps.restartStatus(),
    }));

    ipcMain.handle("prefs:list-models", async () => {
      const whisper = await Promise.all(WHISPER_MODELS.map((m) => describeModel(this.deps.modelManager, this.downloads, m)));
      const llm = await Promise.all(LLM_MODELS.map((m) => describeModel(this.deps.modelManager, this.downloads, m)));
      return { whisper, llm, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      // Already running (e.g. the window was closed and reopened mid-download):
      // hand back the same promise, so the caller resolves when it really ends.
      if (!this.downloads.isActive(desc.id) && (await this.deps.modelManager.isInstalled(desc))) return;
      return this.downloads.start(desc.id, async (signal, report) => {
        // Once per stream chunk is far more than the card needs: ~10/s, plus the final 100%.
        const gate = createEmitGate(100);
        try {
          await this.deps.modelManager.download(
            desc,
            (p) => {
              report(p);
              if (gate(p.bytes >= p.total)) {
                this.send("prefs:download-progress", { id: desc.id, bytes: p.bytes, total: p.total });
              }
            },
            { signal },
          );
        } catch (err) {
          // Never forward raw messages: they can carry URLs and 64-char hashes.
          throw new Error(downloadErrorText(err));
        }
      });
    });

    ipcMain.on("prefs:cancel-download", (_e, id: unknown) => {
      if (typeof id === "string") this.downloads.cancel(id);
    });

    ipcMain.on("prefs:relaunch", () => {
      // Schedule the relaunch + quit on the next tick so the IPC ack
      // can return to the renderer before the process tears down.
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
    });

    ipcMain.handle("prefs:delete-model", async (_e, args: { kind: "whisper" | "llm"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      // Don't allow deleting the active model — that would break the next app start.
      const prefs = await this.deps.preferencesStore.load();
      const selectedKey = args.kind === "whisper" ? prefs.whisperModelId : prefs.llmModelId;
      if (selectedKey === args.id) {
        throw new Error("Can't delete the active model. Choose another model first.");
      }
      const path = this.deps.modelManager.getInstalledPath(desc);
      const { unlink } = await import("node:fs/promises");
      await unlink(path).catch(() => undefined);
    });

    ipcMain.handle("prefs:permissions-status", (_e, opts?: { automation?: boolean }) =>
      this.deps.permissionsStatus(opts?.automation === true),
    );

    ipcMain.on("prefs:open-system-settings", (_e, pane: unknown) => {
      const suffix = typeof pane === "string" ? SETTINGS_PANES[pane] : undefined;
      if (suffix) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${suffix}`);
    });

    ipcMain.on("prefs:open-logs", () => {
      void shell.openPath(this.deps.logDir);
    });

    ipcMain.on("prefs:reveal-models", () => {
      void shell.openPath(getModelsDir());
    });

    ipcMain.on("prefs:open-external", (_e, url: unknown) => {
      // Only the project page: the renderer must not be able to open arbitrary URLs.
      if (url === "https://github.com/Fraank98/open-flow") void shell.openExternal(url);
    });

    ipcMain.handle("prefs:reset-setup", async (): Promise<boolean> => {
      const options = {
        type: "question" as const,
        message: "Run setup again?",
        detail: "This will reopen the setup assistant and restart open-flow. Your models stay on disk.",
        buttons: ["Run Setup Again", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      };
      const parent = this.win && !this.win.isDestroyed() ? this.win : null;
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response !== 0) return false;
      await this.deps.preferencesStore.update({ setupComplete: false, setupStep: "welcome" });
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
      return true;
    });

    ipcMain.handle("prefs:app-info", () => ({ version: this.deps.version }));
  }
}
