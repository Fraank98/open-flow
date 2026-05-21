import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { PipelineCoordinator } from "./pipeline-coordinator.js";
import { AudioOrchestrator } from "./audio-orchestrator.js";
import { PTTManager } from "./ptt-manager.js";
import { OverlayWindow } from "./overlay-window.js";
import { MenubarApp } from "./menubar-app.js";
import { createDefaultTextInjector } from "./text-injector.js";
import { createLogger } from "./logger.js";
import { WhisperRunner } from "./whisper-runner.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";
import { PreferencesStore } from "./preferences-store.js";
import { ModelManager } from "./model-manager.js";
import { getModelById } from "./model-catalog.js";
import { getModelsDir, modelFilePath } from "./utils/model-paths.js";
import { SetupWizard } from "./setup-wizard.js";
import { PreferencesWindow } from "./preferences-window.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");

const SAMPLE_RATE = 16_000;

// In packaged builds, native binaries live in Contents/Resources/bin/ (via
// electron-builder's extraResources). In dev, they're at resources/bin/ in the
// repo root. `app.isPackaged` distinguishes the two.
const BIN_DIR = app.isPackaged
  ? join(process.resourcesPath, "bin")
  : join(APP_ROOT, "resources", "bin");
const WHISPER_BIN = join(BIN_DIR, "whisper-cli");
const LLAMA_BIN = join(BIN_DIR, "llama-cli");

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");

async function main(): Promise<void> {
  await app.whenReady();

  const preferencesStore = new PreferencesStore(PREFS_PATH);
  const modelManager = new ModelManager();
  let prefs = await preferencesStore.load();

  const logger = createLogger({ dir: LOG_DIR, debug: prefs.debugLogging, maxBytes: 5 * 1024 * 1024 });
  await logger.info("app starting", { setupComplete: prefs.setupComplete });

  // First-launch: run setup wizard until setupComplete=true
  if (!prefs.setupComplete) {
    const wizard = new SetupWizard({ modelManager, preferencesStore });
    const completed = await wizard.run();
    if (!completed) {
      await logger.warn("setup wizard closed without completion; quitting");
      app.quit();
      return;
    }
    prefs = await preferencesStore.load();
  }

  // Resolve model paths from prefs + catalog
  const whisperDesc = getModelById("whisper", prefs.whisperModelId);
  const llmDesc = getModelById("llm", prefs.llmModelId);
  if (!whisperDesc || !llmDesc) {
    await logger.error("preferences reference unknown model; resetting setup", {
      whisperId: prefs.whisperModelId,
      llmId: prefs.llmModelId,
    });
    await preferencesStore.update({ setupComplete: false });
    app.relaunch();
    app.quit();
    return;
  }
  const whisperModelPath = modelFilePath(whisperDesc);
  const llmModelPath = modelFilePath(llmDesc);

  // Confirm files actually exist (catch the "model deleted manually" case)
  if (!(await modelManager.isInstalled(whisperDesc)) || !(await modelManager.isInstalled(llmDesc))) {
    await logger.error("selected model missing on disk; re-running setup", {
      modelsDir: getModelsDir(),
    });
    await preferencesStore.update({ setupComplete: false });
    app.relaunch();
    app.quit();
    return;
  }

  const mic = await checkMicrophone();
  const acc = await checkAccessibilityViaProbe();
  await logger.info("permissions", { mic, accessibility: acc });

  const whisper = new WhisperRunner({
    binaryPath: WHISPER_BIN,
    modelPath: whisperModelPath,
    timeoutMs: 60_000,
  });
  const llm = new LLMCleaner({
    binaryPath: LLAMA_BIN,
    modelPath: llmModelPath,
    timeoutMs: 30_000,
  });
  const injector = createDefaultTextInjector();
  const orchestrator = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: SAMPLE_RATE });

  const coordinator = new PipelineCoordinator({
    transcribe: async ({ wavBytes, language }) => {
      const tmp = join(app.getPath("temp"), `open-flow-${Date.now()}.wav`);
      const { writeFile, unlink } = await import("node:fs/promises");
      await writeFile(tmp, wavBytes);
      try {
        return await whisper.transcribe({ wavPath: tmp, language });
      } finally {
        unlink(tmp).catch(() => undefined);
      }
    },
    clean: async (raw) => llm.clean(raw),
    inject: async (text) => injector.inject(text),
    logger,
  });

  const overlay = new OverlayWindow();
  await overlay.create();
  coordinator.onStateChange((state) => {
    overlay.sendState(state);
    if (state === "idle") {
      setTimeout(() => overlay.hide(), 500);
    } else {
      overlay.show();
    }
  });

  const recorderWin = new BrowserWindow({
    width: 320,
    height: 80,
    show: false,
    webPreferences: {
      preload: join(APP_ROOT, "dist", "preload", "recorder-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await recorderWin.loadFile(join(APP_ROOT, "src", "renderer", "recorder.html"));

  ipcMain.on("audio:chunk", (_e, arrayBuffer: ArrayBuffer, byteOffset: number, length: number) => {
    const view = new Float32Array(arrayBuffer, byteOffset, length);
    const chunk = new Float32Array(view.length);
    chunk.set(view);
    orchestrator.appendChunk(chunk);
  });
  ipcMain.on("audio:error", async (_e, message: string) => {
    await logger.error("recorder error", { message });
  });

  const ptt = new PTTManager({ appRoot: APP_ROOT, isPackaged: app.isPackaged });
  ptt.on("ready", () => {
    void logger.info("PTT armed (in-process NSEvent monitor)");
  });
  ptt.on("trustRequired", () => {
    void logger.error("PTT requires Accessibility — prompt shown to user");
  });
  const prefsWindow = new PreferencesWindow({ modelManager, preferencesStore });
  const menubar = new MenubarApp({
    onToggleEnabled: () => {
      if (menubar.isEnabled()) {
        ptt.start();
      } else {
        ptt.stop();
      }
    },
    onOpenPreferences: () => {
      void prefsWindow.open();
    },
    onQuit: () => app.quit(),
  });

  ptt.on("start", () => {
    orchestrator.reset();
    coordinator.startRecording();
    recorderWin.webContents.send("audio:start");
    menubar.setStatus("Recording…");
  });
  ptt.on("stop", async () => {
    recorderWin.webContents.send("audio:stop");
    await new Promise((r) => setTimeout(r, 250));
    const samples = orchestrator.snapshot();
    const lang = (await preferencesStore.load()).language;
    await coordinator.finishWithAudio(samples, SAMPLE_RATE, lang);
    menubar.setStatus("Idle");
  });
  ptt.on("cancel", () => {
    // User tapped Option briefly without holding — cancel any in-flight
    // recording state so the next real press starts fresh.
    coordinator.cancel();
    menubar.setStatus("Idle");
  });

  ptt.start();
  if (!ptt.isTrusted()) {
    await logger.error("PTT start failed: not trusted for Accessibility");
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      title: "open-flow needs Accessibility access",
      message: "Hold-to-dictate requires macOS Accessibility permission",
      detail:
        "Open System Settings → Privacy & Security → Accessibility and enable open-flow, then quit and relaunch the app.",
      buttons: ["Open System Settings", "Quit", "Continue without hotkey"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 0) {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      app.quit();
      return;
    } else if (choice === 1) {
      app.quit();
      return;
    }
  } else {
    await logger.info("PTT armed");
  }

  menubar.create();

  app.on("will-quit", () => {
    ptt.stop();
    overlay.destroy();
    menubar.destroy();
  });

  app.on("window-all-closed", () => {
    // intentional no-op — menubar app stays alive
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  app.exit(1);
});
