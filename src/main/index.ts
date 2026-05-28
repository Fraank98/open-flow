import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from "electron";
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
import { StreamingWhisperRunner, PartialTranscript, PassTiming } from "./streaming-whisper-runner.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { LLMServer } from "./llm-server.js";
import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";
import { PreferencesStore } from "./preferences-store.js";
import { ModelManager } from "./model-manager.js";
import { getModelById } from "./model-catalog.js";
import { getModelsDir, modelFilePath } from "./utils/model-paths.js";
import { SetupWizard } from "./setup-wizard.js";
import { PreferencesWindow } from "./preferences-window.js";
import { MediaController, createDefaultScripter } from "./media-control.js";

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

  // Prevent macOS App Nap from suspending this background (menubar) app while
  // idle. App Nap throttles timers/threads and lets the GPU power down, which
  // intermittently makes the FIRST dictation after a long idle take 10-20s
  // (the in-flight whisper pass stalls). 'prevent-app-suspension' keeps the
  // process responsive without keeping the display awake.
  const powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  await logger.info("power save blocker", {
    id: powerSaveBlockerId,
    active: powerSaveBlocker.isStarted(powerSaveBlockerId),
  });

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

  // Pauses Spotify / Apple Music when dictation starts (via AppleScript that
  // checks each app's player state first, so we never blindly toggle media
  // that the user manually paused). Wrapped in try/catch with a no-op
  // fallback to match the pattern used by streamingWhisper / llama-server.
  let mediaController: {
    pauseIfPlaying(): Promise<void>;
    resume(): Promise<void>;
  } = {
    async pauseIfPlaying() {},
    async resume() {},
  };
  try {
    mediaController = new MediaController(createDefaultScripter());
    await logger.info("media-control ready");
  } catch (err) {
    await logger.error("media-control init failed; continuing without audio pause", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // Pause/resume now run osascript, so they return Promises. The 4 call sites
  // fire-and-forget — these are best-effort UX side-effects, never block the
  // pipeline. Swallow + log so a hiccup never surfaces as an unhandled
  // rejection but is still visible in the log.
  const swallowMcError = (op: string) => (err: unknown) => {
    void logger.warn(`media-control ${op} failed`, {
      message: err instanceof Error ? err.message : String(err),
    });
  };

  // Streaming Whisper via the in-process native addon. Model loads once
  // into a whisper_context that stays in RAM; each utterance is a
  // start → feedSamples* → processChunk* → finalize cycle.
  let streamingWhisper: StreamingWhisperRunner | null = null;
  try {
    await logger.info("streaming whisper loading model", { model: whisperModelPath });
    const t0 = Date.now();
    streamingWhisper = new StreamingWhisperRunner({
      appRoot: APP_ROOT,
      isPackaged: app.isPackaged,
      modelPath: whisperModelPath,
      chunkIntervalMs: 1500,
      // Keep the Metal GPU warm while idle so the first chunk after a pause
      // doesn't pay the ~10x cold-start ramp (the powerSaveBlocker prevents
      // process suspension but not GPU clock-down).
      keepaliveIntervalMs: 20_000,
    });
    streamingWhisper.on("partial", (p: PartialTranscript) => {
      void logger.info("partial transcript", { newSuffix: p.newSuffix });
      // Forwarded to the overlay further down once it exists.
    });
    // Per-pass timing: queueMs (waiting for a libuv worker thread) vs execMs
    // (running inference). A large execMs on the first pass after idle points
    // to GPU/App-Nap; a large queueMs points to threadpool starvation.
    streamingWhisper.on("timing", (t: PassTiming) => {
      // Keepalive fires every 20s forever — log it at debug so it doesn't spam
      // the normal log, but is available when debugLogging is on.
      const meta = { phase: t.phase, queueMs: t.queueMs, execMs: t.execMs, aborted: t.aborted };
      if (t.phase === "keepalive") void logger.debug("whisper pass timing", meta);
      else void logger.info("whisper pass timing", meta);
    });
    await logger.info("streaming whisper ready", { loadMs: Date.now() - t0 });
  } catch (err) {
    await logger.error("streaming whisper init failed; falling back to batch path", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback batch path (whisper-server). Only used if streaming init failed.
  const whisperServer = new WhisperServer({
    binaryPath: WHISPER_SERVER_BIN,
    modelPath: whisperModelPath,
    port: 18081,
  });
  if (!streamingWhisper) {
    try {
      await whisperServer.start();
      await logger.info("whisper-server ready (fallback)", {
        endpoint: whisperServer.getEndpoint(),
      });
    } catch (err) {
      await logger.error("whisper-server failed to start", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
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
    contextSize: 1536,
    // Prime the prefix cache with the actual cleanup template so the system
    // instructions are already prefilled when the first dictation hits.
    warmupPrompt: buildCleanupPrompt("test", prefs.language),
    // Keep the GPU pipeline hot between dictations — without this every cleanup
    // pays the ~2.5s cold-start (the prior build showed 2.6-3s cleanups).
    keepaliveMs: 20_000,
  });
  // Only run llama-server when LLM cleanup is enabled. With it off (whisper-only
  // mode) the model would just sit in RAM and its keepalive would contend with
  // whisper for the GPU every 20s — pure waste. Toggling the pref on at runtime
  // takes effect after a restart (see the resilient clean() wiring below).
  if (prefs.useLlmCleanup) {
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
  } else {
    await logger.info("LLM cleanup disabled in prefs — llama-server not started");
  }
  const llm = new LLMCleaner({
    endpoint: llmServer.getEndpoint(),
    timeoutMs: 15_000,
  });
  const injector = createDefaultTextInjector();
  const orchestrator = new AudioOrchestrator({ maxDurationMs: 60_000, sampleRate: SAMPLE_RATE });

  const coordinator = new PipelineCoordinator({
    transcribe: async ({ wavBytes, language }) => {
      if (streamingWhisper) {
        // The streaming runner has been receiving samples in parallel
        // with the recorder; finalize runs one last inference and returns
        // the full transcript.
        const t0 = Date.now();
        const text = await streamingWhisper.finalize(language);
        return { text, language: null, durationMs: Date.now() - t0 };
      }
      return whisper.transcribe({ wavBytes, language });
    },
    clean: async (raw, languageHint) => {
      // If the user turned LLM cleanup on at runtime but the server wasn't
      // started at launch, don't crash the pipeline — fall back to raw. It
      // works properly after a restart.
      if (!llmServer.isRunning()) {
        await logger.warn("LLM cleanup requested but llama-server not running — restart to enable; using raw");
        return { text: raw, usedFallback: true, durationMs: 0 };
      }
      return llm.clean(raw, languageHint);
    },
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
  // Forward streaming whisper partial transcripts to the overlay for the
  // live preview underneath the "Recording…" label.
  if (streamingWhisper) {
    streamingWhisper.on("partial", (p: PartialTranscript) => {
      overlay.sendPartial(p.full);
    });
  }

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
    if (streamingWhisper) streamingWhisper.feedSamples(chunk);
  });
  ipcMain.on("audio:error", async (_e, message: string) => {
    await logger.error("recorder error", { message });
  });
  ipcMain.on("pipeline:cancel", async () => {
    await logger.info("pipeline:cancel from UI");
    recorderWin.webContents.send("audio:stop");
    orchestrator.reset();
    coordinator.cancel();
    void mediaController.resume().catch(swallowMcError("resume"));
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
    if (streamingWhisper) {
      // Read language synchronously from the last-known prefs — the chunk
      // loop needs a language hint right away. We re-read prefs again at
      // finalize time so a Save during recording still takes effect there.
      streamingWhisper.start(prefs.language);
    }
    recorderWin.webContents.send("audio:start");
  });
  ptt.on("start", () => {
    if (pipelineBusy) return;
    coordinator.startRecording();
    menubar.setStatus("Recording…");
    // Pause music/video here (not on `arm`): `arm` fires the moment Option
    // goes down, which also happens when Option is used as a modifier in a
    // chord (Option+letter for accents, Option+arrow, ...). PTTManager only
    // emits `start` after it has confirmed a real dictation gesture, so this
    // avoids the flicker pause/resume you'd otherwise see on chord keys.
    void mediaController.pauseIfPlaying().catch(swallowMcError("pause"));
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
      void mediaController.resume().catch(swallowMcError("resume"));
    }
  });
  ptt.on("cancel", () => {
    if (pipelineBusy) return;
    void logger.info("PTT cancel — discarding recording");
    recorderWin.webContents.send("audio:stop");
    orchestrator.reset();
    if (streamingWhisper) streamingWhisper.cancel();
    // Reset coordinator state to idle. Without this the overlay would stay
    // stuck at "Recording…" because state change → idle is what hides it.
    coordinator.cancel();
    void mediaController.resume().catch(swallowMcError("resume"));
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
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    if (streamingWhisper) streamingWhisper.release();
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
