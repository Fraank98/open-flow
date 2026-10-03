import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell, systemPreferences } from "electron";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModelManager } from "./model-manager.js";
import { TIERS, getModelById, getTier, tierTotals } from "./model-catalog.js";
import {
  AccessibilityNative,
  checkAccessibility,
  checkAutomationViaProbe,
  checkMicrophone,
  requestAccessibility,
} from "./permissions.js";
import { describeDownloadError } from "./utils/download-errors.js";
import { ensureFreeSpace } from "./utils/disk-space.js";
import { getModelsDir } from "./utils/model-paths.js";
import { PreferencesStore, SetupStep } from "./preferences-store.js";
import type { WizardPipelineState } from "./utils/wizard-pipeline-state.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

const SETTINGS_PANES: Record<string, string> = {
  accessibility: "Privacy_Accessibility",
  microphone: "Privacy_Microphone",
  automation: "Privacy_Automation",
};

// Steps the renderer may save; "ready" is written by the main process alone,
// when the models are in place.
const SAVABLE_STEPS: readonly SetupStep[] = ["welcome", "permissions", "tier", "download"];

/** Same backgrounds as lib/theme.css, so the window never flashes the wrong colour. */
const BG_LIGHT = "#f5f5f7";
const BG_DARK = "#1e1e1e";

export interface SetupDownloadError {
  title: string;
  hint: string;
  retryable: boolean;
  code: string;
}

export interface SetupWizardDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
  /** Live AX trust (the PTT manager). */
  accessibility: AccessibilityNative;
}

export class SetupWizard {
  private win: BrowserWindow | null = null;
  /** Resolves `run()`: true once setup is complete, false if the window closed first. */
  private resolver: ((completed: boolean) => void) | null = null;
  private appReady = false;
  /** Aborts the model download in flight (cancel button, or quitting setup). */
  private abort: AbortController | null = null;
  /** True once the models are on disk and setupComplete is saved. */
  private setupSaved = false;
  private closeConfirmed = false;
  private confirmingClose = false;

  constructor(private readonly deps: SetupWizardDeps) {}

  /** True while the wizard window exists (it stays open after setup, on the "ready" step). */
  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  /** Tells the "ready" step that models are loaded and push-to-talk is armed. */
  markAppReady(): void {
    this.appReady = true;
    this.send("setup:app-ready");
  }

  /** Forwards the dictation pipeline state to the live "try it" line. */
  sendPipelineState(state: WizardPipelineState): void {
    this.send("setup:pipeline-state", state);
  }

  /**
   * Opens the wizard. Resolves true as soon as setup is complete (models
   * downloaded, setupComplete saved) — the window stays open on the "ready"
   * step while the app keeps booting — or false if it is closed before that.
   */
  async run(): Promise<boolean> {
    const win = new BrowserWindow({
      width: 640,
      height: 620,
      title: "open-flow Setup",
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "setup-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.win = win;
    win.once("ready-to-show", () => win.show());

    // Closing halfway asks first; the progress is already saved, so setup resumes later.
    win.on("close", (event) => {
      if (this.setupSaved || this.closeConfirmed) return;
      event.preventDefault();
      if (this.confirmingClose) return;
      this.confirmingClose = true;
      void dialog
        .showMessageBox(win, {
          type: "question",
          message: "Quit setup?",
          detail: "Your progress is saved. open-flow will pick up where you left off next time you open it.",
          buttons: ["Quit Setup", "Keep Going"],
          defaultId: 1,
          cancelId: 1,
        })
        .then(({ response }) => {
          this.confirmingClose = false;
          if (response !== 0) return;
          this.closeConfirmed = true;
          this.abort?.abort();
          if (!win.isDestroyed()) win.destroy();
        });
    });

    this.registerHandlers();
    await win.loadFile(join(APP_ROOT, "src", "renderer", "setup.html"));

    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      win.on("closed", () => {
        this.abort?.abort();
        if (this.resolver) {
          this.resolver(this.setupSaved);
          this.resolver = null;
        }
        this.unregisterHandlers();
      });
    });
  }

  private registerHandlers(): void {
    ipcMain.handle("setup:get-initial-state", async () => {
      const prefs = await this.deps.preferencesStore.load();
      return {
        micPermission: await checkMicrophone(),
        accessibilityPermission: checkAccessibility(this.deps.accessibility),
        // Not probed here: the osascript probe raises the macOS Automation prompt
        // if it was never answered, which must only happen when the user asks.
        automationPermission: "unknown" as const,
        setupStep: prefs.setupStep,
        setupTierId: prefs.setupTierId,
        launchAtLogin: prefs.launchAtLogin,
        freeBytes: await this.freeBytes(),
        appReady: this.appReady,
        tiers: await Promise.all(
          TIERS.map(async (t) => {
            const { sizeBytes, ramBytes } = tierTotals(t);
            const whisper = getModelById("whisper", t.whisperId);
            const llm = getModelById("llm", t.llmId);
            const installed =
              !!whisper &&
              !!llm &&
              (await this.deps.modelManager.isInstalled(whisper)) &&
              (await this.deps.modelManager.isInstalled(llm));
            return {
              id: t.id,
              label: t.label,
              description: t.description,
              summary: t.summary,
              transcriptionNote: t.transcriptionNote,
              recommended: t.recommended,
              sizeBytes,
              ramBytes,
              installed,
              licenseNote: t.licenseNote,
            };
          }),
        ),
      };
    });

    ipcMain.on("setup:save-step", (_e, p: { step?: string; tierId?: string | null }) => {
      if (this.setupSaved || !p || !SAVABLE_STEPS.includes(p.step as SetupStep)) return;
      const patch: { setupStep: SetupStep; setupTierId?: string | null } = { setupStep: p.step as SetupStep };
      if (p.tierId === null || (typeof p.tierId === "string" && getTier(p.tierId))) patch.setupTierId = p.tierId;
      void this.deps.preferencesStore.update(patch).catch(() => undefined);
    });

    ipcMain.on("setup:set-launch-at-login", (_e, enabled: unknown) => {
      if (typeof enabled !== "boolean") return;
      void this.deps.preferencesStore.update({ launchAtLogin: enabled }).catch(() => undefined);
      // The app's own launch-at-login sync ran when setup completed, before this
      // toggle could change: apply the choice right away.
      try {
        app.setLoginItemSettings({ openAtLogin: enabled });
      } catch {
        /* unsigned apps may need a one-time approval in System Settings */
      }
    });

    ipcMain.handle("setup:request-mic", async () => {
      // askForMediaAccess returns boolean
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted ? "granted" : "denied";
    });

    // Asks macOS for Accessibility: this is what lists open-flow in System Settings.
    ipcMain.handle("setup:request-accessibility", () => requestAccessibility(this.deps.accessibility));

    // Mic and Accessibility are cheap and polled every second. Automation runs
    // osascript (and may raise the macOS prompt), so it is only probed on request.
    ipcMain.handle("setup:refresh-permissions", async (_e, opts?: { automation?: boolean }) => ({
      mic: await checkMicrophone(),
      accessibility: checkAccessibility(this.deps.accessibility),
      automation: opts?.automation ? await checkAutomationViaProbe() : null,
    }));

    ipcMain.on("setup:open-system-settings", (_e, pane: string) => {
      const suffix = SETTINGS_PANES[pane];
      if (suffix) shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${suffix}`);
    });

    ipcMain.handle("setup:start-download", async (_e, tierId: string) => {
      if (this.abort) return; // a download is already running
      const tier = getTier(tierId);
      const whisper = tier && getModelById("whisper", tier.whisperId);
      const llm = tier && getModelById("llm", tier.llmId);
      if (!tier || !whisper || !llm) {
        this.emitDone({
          ok: false,
          error: { title: "Unknown quality level", hint: "Choose another one.", retryable: false, code: "unknown-tier" },
        });
        return;
      }
      const abort = new AbortController();
      this.abort = abort;
      try {
        const files = [whisper, llm] as const;
        for (const [i, desc] of files.entries()) {
          const stage = desc.label;
          const fileIndex = i + 1;
          if (await this.deps.modelManager.isInstalled(desc)) {
            this.emitProgress(stage, desc.sizeBytes, desc.sizeBytes, fileIndex, files.length);
            continue;
          }
          await this.deps.modelManager.download(
            desc,
            ({ bytes, total }) => this.emitProgress(stage, bytes, total, fileIndex, files.length),
            { signal: abort.signal },
          );
        }
        await this.deps.preferencesStore.update({
          setupComplete: true,
          setupStep: "ready",
          setupTierId: tier.id,
          whisperModelId: whisper.id,
          llmModelId: llm.id,
        });
        this.setupSaved = true;
        this.emitDone({ ok: true });
        // Setup is done: let the app carry on booting while this window stays open.
        this.resolver?.(true);
        this.resolver = null;
      } catch (err) {
        // describeDownloadError never forwards raw messages: they can carry URLs and 64-char hashes.
        const { title, hint, retryable, code } = describeDownloadError(err);
        this.emitDone({ ok: false, error: { title, hint, retryable, code } });
      } finally {
        this.abort = null;
      }
    });

    ipcMain.on("setup:cancel-download", () => this.abort?.abort());

    // Finish only closes the window; run() already resolved when setup completed.
    ipcMain.on("setup:finish", () => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.close();
      }
    });
  }

  private unregisterHandlers(): void {
    ipcMain.removeHandler("setup:get-initial-state");
    ipcMain.removeHandler("setup:request-mic");
    ipcMain.removeHandler("setup:request-accessibility");
    ipcMain.removeHandler("setup:refresh-permissions");
    ipcMain.removeHandler("setup:start-download");
    ipcMain.removeAllListeners("setup:save-step");
    ipcMain.removeAllListeners("setup:set-launch-at-login");
    ipcMain.removeAllListeners("setup:cancel-download");
    ipcMain.removeAllListeners("setup:open-system-settings");
    ipcMain.removeAllListeners("setup:finish");
  }

  /** Free bytes on the volume that holds the models; null when it can't be read. */
  private async freeBytes(): Promise<number | null> {
    try {
      const dir = getModelsDir();
      await mkdir(dir, { recursive: true });
      return await ensureFreeSpace(dir, 0);
    } catch {
      return null;
    }
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args);
  }

  private emitProgress(stage: string, bytes: number, total: number, fileIndex: number, fileCount: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-progress", { stage, bytes, total, fileIndex, fileCount });
    }
  }

  private emitDone(result: { ok: boolean; error?: SetupDownloadError }): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-done", result);
    }
  }
}
