import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WHISPER_MODELS, LLM_MODELS, REPLY_MODELS, getModelById, replyCards } from "./model-catalog.js";
import { validateReplyAccelerator, isSystemReservedKeyEvent } from "./utils/reply-hotkey.js";
import { appNameFromPath, findAppPathByBundleId, isBundleId, readBundleId, type ExecFn } from "./utils/app-bundle.js";
import { ModelManager } from "./model-manager.js";
import { PreferencesStore, Preferences } from "./preferences-store.js";
import type { ReplyServerState } from "../shared/reply-types.js";
import { downloadErrorText } from "./utils/download-errors.js";
import { LANGUAGES } from "./utils/languages.js";
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

const execCommand: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });

export interface AppInfo {
  bundleId: string;
  /** Readable name, or null when the app isn't installed here (the UI shows the bundle id). */
  name: string | null;
  /** 16 px icon as a data URL, when the app was found. */
  icon: string | null;
}

/** Same backgrounds as lib/theme.css, so the window never flashes the wrong colour. */
const BG_LIGHT = "#f5f5f7";
const BG_DARK = "#1e1e1e";

const APP_ROOT = join(dirname(__filename), "..", "..");

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

export interface ReplyUiStatus {
  serverState: ReplyServerState;
  serverError: string | null;
  /** false when globalShortcut.register refused the accelerator. */
  hotkeyRegistered: boolean;
  /** false when the ax_context addon could not be loaded (degradation L6). */
  nativeOk: boolean;
  /** Bundle id of the last app the reader refused (§Deviazioni 3). */
  lastBlockedBundleId: string | null;
  /** true until the reply wiring has run at boot; the other fields are
   *  placeholders then (nativeOk in particular is not known yet). */
  booting: boolean;
}

export interface PreferencesWindowDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
  /** Read-only snapshot for the reply section. */
  replyStatus: () => ReplyUiStatus;
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
  /** True while the shortcut recorder has focus (reported by the renderer). */
  private recorderActive = false;
  private readonly savedListeners: Array<(prefs: Preferences) => void> = [];
  /** Downloads in flight, by model id: Cancel aborts them and a reopened window re-attaches to them. */
  private readonly downloads = new DownloadTracker();

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
    // While the recorder has focus, ⌘Q/⌘W/⌘H/⌘M/⌘Tab/⌘Space/⌘,/⌘` would run their
    // menu or system action instead of being recorded. before-input-event runs
    // before the menu shortcuts and the page, so swallowing them here keeps the
    // window alive; the renderer is told so it can explain the refusal.
    win.webContents.on("before-input-event", (event, input) => {
      if (!this.recorderActive || input.type !== "keyDown") return;
      if (!isSystemReservedKeyEvent(input)) return;
      event.preventDefault();
      this.send("prefs:reserved-key");
    });
    win.on("closed", () => {
      this.recorderActive = false;
      // Closing the window leaves downloads running; their progress just has no listener.
      if (this.win === win) this.win = null;
    });
    await win.loadFile(join(APP_ROOT, "src", "renderer", "preferences.html"), tab ? { hash: tab } : undefined);
  }

  private async iconFor(appPath: string): Promise<string | null> {
    try {
      return (await app.getFileIcon(appPath, { size: "small" })).toDataURL();
    } catch {
      return null;
    }
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  private async applyUpdate(rawPatch: unknown): Promise<Preferences> {
    const patch = sanitizePrefsPatch(rawPatch);
    // Concurrent updates are serialised inside the store.
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
      // Reply models are described like the others; the tier layers its own name
      // and the benchmark text (shown collapsed) on top: one card per tier.
      const reply = await Promise.all(
        replyCards().map(async (card) => {
          const model = getModelById("reply", card.id);
          if (!model) throw new Error(`Reply card references an unknown model: ${card.id}`);
          return {
            ...(await describeModel(this.deps.modelManager, this.downloads, model)),
            label: card.label,
            description: card.description,
            details: card.details,
            tierId: card.tierId,
          };
        }),
      );
      return { whisper, llm, reply, languages: LANGUAGES };
    });

    ipcMain.handle("prefs:download-model", async (_e, args: { kind: "whisper" | "llm" | "reply"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : args.kind === "llm" ? LLM_MODELS : REPLY_MODELS;
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

    ipcMain.handle("prefs:delete-model", async (_e, args: { kind: "whisper" | "llm" | "reply"; id: string }) => {
      const list = args.kind === "whisper" ? WHISPER_MODELS : args.kind === "llm" ? LLM_MODELS : REPLY_MODELS;
      const desc = list.find((m) => m.id === args.id);
      if (!desc) throw new Error(`Unknown model: ${args.kind}/${args.id}`);
      // Don't allow deleting the active model — that would break the next app start.
      const prefs = await this.deps.preferencesStore.load();
      const selectedKey = args.kind === "whisper" ? prefs.whisperModelId : args.kind === "llm" ? prefs.llmModelId : prefs.replyModelId;
      if (selectedKey === args.id) {
        throw new Error("Can't delete the active model. Choose another model first.");
      }
      if (this.downloads.isActive(desc.id)) {
        throw new Error("This model is downloading. Cancel the download first.");
      }
      // Also drops a leftover <file>.partial; errors other than "not found" propagate to the UI.
      await this.deps.modelManager.deleteModel(desc);
    });

    // Add app…: pick a .app in /Applications, read its bundle id for the list.
    ipcMain.handle("prefs:pick-app", async (): Promise<AppInfo | null> => {
      const options = {
        defaultPath: "/Applications",
        properties: ["openFile" as const],
        filters: [{ name: "Applications", extensions: ["app"] }],
      };
      const parent = this.win && !this.win.isDestroyed() ? this.win : null;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      const appPath = result.canceled ? undefined : result.filePaths[0];
      if (!appPath) return null;
      const bundleId = await readBundleId(appPath, execCommand);
      if (!bundleId) throw new Error("Couldn't read this app's identifier. Choose an application from /Applications.");
      return { bundleId, name: appNameFromPath(appPath), icon: await this.iconFor(appPath) };
    });

    // Readable names (and icons) for the bundle ids in the list.
    ipcMain.handle("prefs:resolve-apps", async (_e, ids: unknown): Promise<AppInfo[]> => {
      if (!Array.isArray(ids)) return [];
      const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && isBundleId(id)))].slice(0, 100);
      return Promise.all(
        unique.map(async (bundleId) => {
          const appPath = await findAppPathByBundleId(bundleId, execCommand);
          if (!appPath) return { bundleId, name: null, icon: null };
          return { bundleId, name: appNameFromPath(appPath), icon: await this.iconFor(appPath) };
        }),
      );
    });

    ipcMain.handle("prefs:reply-status", (): ReplyUiStatus => this.deps.replyStatus());

    ipcMain.on("prefs:recorder-active", (e, active: unknown) => {
      if (this.win && !this.win.isDestroyed() && e.sender === this.win.webContents) this.recorderActive = active === true;
    });

    ipcMain.handle("prefs:validate-reply-hotkey", (_e, accelerator: string) => validateReplyAccelerator(accelerator));

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
      await this.deps.preferencesStore.update({ setupComplete: false, setupStep: "welcome", setupReason: null });
      setImmediate(() => {
        app.relaunch();
        app.quit();
      });
      return true;
    });

    ipcMain.handle("prefs:app-info", () => ({ version: this.deps.version }));
  }
}
