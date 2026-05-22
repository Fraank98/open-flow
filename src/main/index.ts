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
import { WhisperServer } from "./whisper-server.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { LLMServer } from "./llm-server.js";
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
const WHISPER_SERVER_BIN = join(BIN_DIR, "whisper-server");
const LLAMA_SERVER_BIN = join(BIN_DIR, "llama-server");

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

  // Apply the launch-at-login preference (no-op if already in sync). macOS
  // tracks this via ServiceManagement; for unsigned apps the user may see a
  // one-time approval prompt in System Settings → General → Login Items.
  try {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current !== prefs.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: prefs.launchAtLogin });
      await logger.info("launch-at-login updated", { openAtLogin: prefs.launchAtLogin });
    }
  } catch (err) {
    await logger.warn("launch-at-login update failed", {
      message: err instanceof Error ? err.message : String(err),
    });
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

  // Start the Whisper server. Model loads once, stays warm in RAM.
  // Per-transcription latency drops from ~1.5-2.5s spawn+load to ~400-800ms
  // pure inference for a typical short utterance.
  const whisperServer = new WhisperServer({
    binaryPath: WHISPER_SERVER_BIN,
    modelPath: whisperModelPath,
    port: 18081,
  });
  try {
    await logger.info("whisper-server starting", { model: whisperModelPath });
    const t0 = Date.now();
    await whisperServer.start();
    await logger.info("whisper-server ready", {
      loadMs: Date.now() - t0,
      endpoint: whisperServer.getEndpoint(),
    });
  } catch (err) {
    await logger.error("whisper-server failed to start", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const whisper = new WhisperRunner({
    endpoint: whisperServer.getEndpoint(),
    timeoutMs: 60_000,
  });

  // Start the LLM server in the background. Model loads once, stays warm,
  // per-cleanup latency drops from ~3-5s (cold spawn) to ~100-500ms.
  const llmServer = new LLMServer({
    binaryPath: LLAMA_SERVER_BIN,
    modelPath: llmModelPath,
    port: 18080,
    contextSize: 2048,
  });
  try {
    await logger.info("llama-server starting", { model: llmModelPath });
    const t0 = Date.now();
    await llmServer.start();
    await logger.info("llama-server ready", {
      loadMs: Date.now() - t0,
      endpoint: llmServer.getEndpoint(),
    });
  } catch (err) {
    await logger.error("llama-server failed to start", {
      message: err instanceof Error ? err.message : String(err),
    });
    // Continue anyway — coordinator will surface clean errors per request.
    // The user can disable LLM cleanup via preferences.
  }
  const llm = new LLMCleaner({
    endpoint: llmServer.getEndpoint(),
    timeoutMs: 15_000,
  });
  const injector = createDefaultTextInjector();
  const orchestrator = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: SAMPLE_RATE });

  const coordinator = new PipelineCoordinator({
    transcribe: async ({ wavBytes, language }) => {
      return whisper.transcribe({ wavBytes, language });
    },
    clean: async (raw, languageHint) => llm.clean(raw, languageHint),
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
  ipcMain.on("pipeline:cancel", async () => {
    await logger.info("pipeline:cancel from UI");
    recorderWin.webContents.send("audio:stop");
    orchestrator.reset();
    coordinator.cancel();
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

  // Diagnostic: log every raw NSEvent we receive so duplicate-fire bugs
  // can be diagnosed from the log.
  ptt.on("rawEvent", (state: string) => {
    void logger.info("PTT rawEvent", { state });
  });

  // Global busy flag: prevent a second 'stop' from firing while a pipeline
  // is still running. The coordinator has its own state guard but stop
  // events are debounced through async setTimeout(250) so two stops can
  // both pass the guard if they happen in the same tick.
  let pipelineBusy = false;

  ptt.on("arm", () => {
    if (pipelineBusy) {
      void logger.warn("arm ignored: pipeline busy");
      return;
    }
    orchestrator.reset();
    recorderWin.webContents.send("audio:start");
  });
  ptt.on("start", () => {
    if (pipelineBusy) return;
    coordinator.startRecording();
    menubar.setStatus("Recording…");
  });
  ptt.on("stop", async () => {
    if (pipelineBusy) {
      void logger.warn("stop ignored: pipeline busy");
      return;
    }
    pipelineBusy = true;
    try {
      // Send audio:stop and wait for the renderer's explicit "end-of-stream"
      // ack instead of a blind 250ms timer. The renderer flushes its residual
      // sample buffer before sending EOS, so by the time we snapshot the
      // orchestrator we have every sample the mic produced.
      const eosT0 = Date.now();
      const eosPromise = new Promise<void>((resolve) => {
        ipcMain.once("audio:end-of-stream", () => resolve());
      });
      recorderWin.webContents.send("audio:stop");
      // 500ms safety fallback in case the renderer hangs / crashes before
      // sending the ack — better to lose a partial sample than to wedge.
      await Promise.race([eosPromise, new Promise<void>((r) => setTimeout(r, 500))]);
      void logger.info("audio EOS received", { ms: Date.now() - eosT0 });
      const samples = orchestrator.snapshot();
      const currentPrefs = await preferencesStore.load();
      await coordinator.finishWithAudio(samples, SAMPLE_RATE, currentPrefs.language, {
        useLlmCleanup: currentPrefs.useLlmCleanup,
        spokenPunctuation: currentPrefs.spokenPunctuation,
      });
      menubar.setStatus("Idle");
    } finally {
      pipelineBusy = false;
    }
  });
  ptt.on("cancel", () => {
    if (pipelineBusy) return;
    void logger.info("PTT cancel — discarding recording");
    recorderWin.webContents.send("audio:stop");
    orchestrator.reset();
    // Reset coordinator state to idle. Without this the overlay would stay
    // stuck at "Recording…" because state change → idle is what hides it.
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
    whisperServer.stop();
    llmServer.stop();
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
