import { BrowserWindow, ipcMain, shell, systemPreferences } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ModelManager } from "./model-manager.js";
import { TIERS, getModelById, getTier } from "./model-catalog.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";
import { PreferencesStore } from "./preferences-store.js";

const __filename = fileURLToPath(import.meta.url);
const APP_ROOT = join(dirname(__filename), "..", "..");

export interface SetupWizardDeps {
  modelManager: ModelManager;
  preferencesStore: PreferencesStore;
}

export class SetupWizard {
  private win: BrowserWindow | null = null;
  private resolver: ((completed: boolean) => void) | null = null;

  constructor(private readonly deps: SetupWizardDeps) {}

  async run(): Promise<boolean> {
    this.win = new BrowserWindow({
      width: 640,
      height: 560,
      title: "open-flow setup",
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: join(APP_ROOT, "dist", "preload", "setup-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    this.registerHandlers();
    await this.win.loadFile(join(APP_ROOT, "src", "renderer", "setup.html"));

    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
      this.win!.on("closed", () => {
        if (this.resolver) {
          this.resolver(false);
          this.resolver = null;
        }
        this.unregisterHandlers();
      });
    });
  }

  private registerHandlers(): void {
    ipcMain.handle("setup:get-initial-state", async () => ({
      micPermission: await checkMicrophone(),
      accessibilityPermission: await checkAccessibilityViaProbe(),
      tiers: TIERS.map((t) => ({ id: t.id, label: t.label, description: t.description })),
    }));

    ipcMain.handle("setup:request-mic", async () => {
      // askForMediaAccess returns boolean
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return granted ? "granted" : "denied";
    });

    ipcMain.handle("setup:refresh-accessibility", async () => checkAccessibilityViaProbe());

    ipcMain.on("setup:open-accessibility-settings", () => {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    });

    ipcMain.handle("setup:start-download", async (_e, tierId: string) => {
      const tier = getTier(tierId);
      if (!tier) {
        this.emitDone({ ok: false, error: `Unknown tier: ${tierId}` });
        return;
      }
      const whisper = getModelById("whisper", tier.whisperId);
      const llm = getModelById("llm", tier.llmId);
      if (!whisper || !llm) {
        this.emitDone({ ok: false, error: "Catalog references missing model" });
        return;
      }
      try {
        for (const [label, desc] of [
          [`Whisper (${whisper.filename})`, whisper],
          [`LLM (${llm.filename})`, llm],
        ] as const) {
          if (await this.deps.modelManager.isInstalled(desc)) {
            this.emitProgress(`${label}: already installed`, desc.sizeBytes, desc.sizeBytes);
            continue;
          }
          await this.deps.modelManager.download(desc, ({ bytes, total }) => {
            this.emitProgress(label, bytes, total);
          });
        }
        await this.deps.preferencesStore.update({
          setupComplete: true,
          whisperModelId: whisper.id,
          llmModelId: llm.id,
        });
        this.emitDone({ ok: true });
      } catch (err) {
        this.emitDone({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    ipcMain.on("setup:finish", () => {
      if (this.resolver) {
        this.resolver(true);
        this.resolver = null;
      }
      if (this.win && !this.win.isDestroyed()) {
        this.win.close();
      }
    });
  }

  private unregisterHandlers(): void {
    ipcMain.removeHandler("setup:get-initial-state");
    ipcMain.removeHandler("setup:request-mic");
    ipcMain.removeHandler("setup:refresh-accessibility");
    ipcMain.removeHandler("setup:start-download");
    ipcMain.removeAllListeners("setup:open-accessibility-settings");
    ipcMain.removeAllListeners("setup:finish");
  }

  private emitProgress(stage: string, bytes: number, total: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-progress", { stage, bytes, total });
    }
  }

  private emitDone(result: { ok: boolean; error?: string }): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("setup:download-done", result);
    }
  }
}
