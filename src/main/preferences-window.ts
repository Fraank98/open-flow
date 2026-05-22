import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS } from "./model-catalog.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import type { ModelDescriptor } from "./utils/model-paths.js";

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

function modelLabel(desc: ModelDescriptor): string {
  return desc.id.replace(/-/g, " ");
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
}

export class PreferencesWindow {
  private win: BrowserWindow | null = null;
  private handlersRegistered = false;

  constructor(private readonly deps: PreferencesWindowDeps) {}

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
      return next;
    });

    ipcMain.handle("prefs:list-models", async () => {
      const whisper = await Promise.all(
        WHISPER_MODELS.map(async (m) => ({
          id: m.id,
          label: modelLabel(m),
          sizeBytes: m.sizeBytes,
          installed: await this.deps.modelManager.isInstalled(m),
        })),
      );
      const llm = await Promise.all(
        LLM_MODELS.map(async (m) => ({
          id: m.id,
          label: modelLabel(m),
          sizeBytes: m.sizeBytes,
          installed: await this.deps.modelManager.isInstalled(m),
        })),
      );
      return { whisper, llm, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : LLM_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      await this.deps.modelManager.download(desc, (p) => {
        if (this.win && !this.win.isDestroyed()) {
          this.win.webContents.send("prefs:download-progress", { id: desc.id, bytes: p.bytes, total: p.total });
        }
      });
    });
  }
}
