import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS, REPLY_MODELS, REPLY_TIERS } from "./model-catalog.js";
import { validateReplyAccelerator } from "./utils/reply-hotkey.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import type { ModelDescriptor } from "./utils/model-paths.js";
import type { ReplyServerState } from "../shared/reply-types.js";

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

export interface ReplyUiStatus {
  serverState: ReplyServerState;
  serverError: string | null;
  /** false when globalShortcut.register refused the accelerator. */
  hotkeyRegistered: boolean;
  /** false when the ax_context addon could not be loaded (degradation L6). */
  nativeOk: boolean;
  /** Bundle id of the last app the reader refused (§Deviazioni 3). */
  lastBlockedBundleId: string | null;
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
  /** Read-only snapshot for the reply section. */
  replyStatus: () => ReplyUiStatus;
}

export class PreferencesWindow {
  private win: BrowserWindow | null = null;
  private handlersRegistered = false;
  private readonly savedListeners: Array<(p: Preferences) => void> = [];

  constructor(private readonly deps: PreferencesWindowDeps) {}

  /** Fires after prefs:save has written the file, so index.ts can apply the
   *  reply preferences (server, hotkey) without an app restart. */
  onSaved(cb: (p: Preferences) => void): void { this.savedListeners.push(cb); }

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
      for (const l of this.savedListeners) l(next);
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
      const reply = await Promise.all(
        REPLY_TIERS.map(async (t) => {
          const desc = REPLY_MODELS.find((m) => m.id === t.replyModelId);
          return {
            id: t.id, label: t.label, description: t.description, modelId: t.replyModelId,
            sizeBytes: desc?.sizeBytes ?? 0,
            installed: desc ? await this.deps.modelManager.isInstalled(desc) : false,
          };
        }),
      );
      return { whisper, llm, replyTiers: reply, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm" | "reply"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : args.kind === "llm" ? LLM_MODELS : REPLY_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      await this.deps.modelManager.download(desc, (p) => {
        if (this.win && !this.win.isDestroyed()) {
          this.win.webContents.send("prefs:download-progress", { id: desc.id, bytes: p.bytes, total: p.total });
        }
      });
    });

    ipcMain.on("prefs:relaunch", () => {
      // Schedule the relaunch + quit on the next tick so the IPC ack
      // can return to the renderer before the process tears down.
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
    });

    ipcMain.handle("prefs:delete-model", async (_e, args: { kind: "whisper" | "llm" | "reply"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : args.kind === "llm" ? LLM_MODELS : REPLY_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      // Don't allow deleting the currently selected model — that would
      // break the next app start.
      const prefs = await this.deps.preferencesStore.load();
      const selectedKey = args.kind === "whisper" ? prefs.whisperModelId : args.kind === "llm" ? prefs.llmModelId : prefs.replyModelId;
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

    ipcMain.handle("prefs:reply-status", (): ReplyUiStatus => this.deps.replyStatus());

    ipcMain.handle("prefs:validate-reply-hotkey", (_e, accelerator: string) => validateReplyAccelerator(accelerator));

    /** The addon does not expose the frontmost app's bundle id (only its
     *  pid), and native/ is out of scope: the UI offers the id of the last
     *  app the reader refused instead (§Deviazioni 3). */
    ipcMain.handle("prefs:reply-blocked-app", (): string | null => this.deps.replyStatus().lastBlockedBundleId);
  }
}
