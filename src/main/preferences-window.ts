import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS } from "./model-catalog.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import { downloadErrorText } from "./utils/download-errors.js";
import type { CatalogModel } from "./model-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
  { id: "it", label: "Italiano" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
];

async function describeModel(manager: ModelManager, m: CatalogModel) {
  return {
    id: m.id,
    label: m.label,
    description: m.description,
    sizeBytes: m.sizeBytes,
    ramBytes: m.ramBytes,
    installed: await manager.isInstalled(m),
    licenseNote: m.licenseNote,
  };
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
  /** Restart-required fields that differ from the prefs the app booted with. */
  restartStatus?: () => Promise<string[]>;
}

export class PreferencesWindow {
  private win: BrowserWindow | null = null;
  private handlersRegistered = false;
  private readonly savedListeners: Array<(prefs: Preferences) => void> = [];

  constructor(private readonly deps: PreferencesWindowDeps) {}

  /** Register a listener called after every successful save with the saved prefs. */
  onSaved(cb: (prefs: Preferences) => void): void {
    this.savedListeners.push(cb);
  }

  async open(): Promise<void> {
    if (this.win && !this.win.isDestroyed()) {
      this.win.focus();
      return;
    }
    this.win = new BrowserWindow({
      width: 580,
      height: 640,
      title: "open-flow preferences",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "preferences-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.registerHandlers();
    this.win.on("closed", () => {
      this.win = null;
    });
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "preferences.html"));
  }

  private registerHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    ipcMain.handle("prefs:load", async (): Promise<Preferences> => {
      return this.deps.preferencesStore.load();
    });

    ipcMain.handle("prefs:save", async (_e, next: Preferences): Promise<Preferences> => {
      await this.deps.preferencesStore.save(next);
      // Apply launch-at-login immediately so the user sees feedback in
      // System Settings → General → Login Items without restarting.
      try {
        const current = app.getLoginItemSettings().openAtLogin;
        if (current !== next.launchAtLogin) {
          app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
        }
      } catch {
        // ignore — pref is saved, will be re-applied on next launch
      }
      for (const cb of this.savedListeners) {
        try {
          cb(next);
        } catch {
          // a misbehaving listener must not fail the save
        }
      }
      return next;
    });

    ipcMain.handle("prefs:restart-status", async (): Promise<{ fields: string[] }> => ({
      fields: this.deps.restartStatus ? await this.deps.restartStatus() : [],
    }));

    ipcMain.handle("prefs:list-models", async () => {
      const whisper = await Promise.all(WHISPER_MODELS.map((m) => describeModel(this.deps.modelManager, m)));
      const llm = await Promise.all(LLM_MODELS.map((m) => describeModel(this.deps.modelManager, m)));
      return { whisper, llm, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      try {
        await this.deps.modelManager.download(desc, (p) => {
          if (this.win && !this.win.isDestroyed()) {
            this.win.webContents.send("prefs:download-progress", { id: desc.id, bytes: p.bytes, total: p.total });
          }
        });
      } catch (err) {
        // Never forward raw messages: they can carry URLs and 64-char hashes.
        throw new Error(downloadErrorText(err));
      }
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
      // Don't allow deleting the currently selected model — that would
      // break the next app start.
      const prefs = await this.deps.preferencesStore.load();
      const selectedKey = args.kind === "whisper" ? prefs.whisperModelId : prefs.llmModelId;
      if (selectedKey === args.id) {
        throw new Error(
          `Cannot delete the currently selected ${args.kind} model. ` +
            `Switch to a different model first, save, then delete this one.`,
        );
      }
      const path = this.deps.modelManager.getInstalledPath(desc);
      const { unlink } = await import("node:fs/promises");
      await unlink(path).catch(() => undefined);
    });
  }
}
