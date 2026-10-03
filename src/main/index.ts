import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { PipelineCoordinator } from "./pipeline-coordinator.js";
import { AudioOrchestrator } from "./audio-orchestrator.js";
import { PTTManager } from "./ptt-manager.js";
import { createPttArmer, PttArmer } from "./utils/ptt-arming.js";
import { OverlayWindow } from "./overlay-window.js";
import { MenubarApp } from "./menubar-app.js";
import { createDefaultTextInjector } from "./text-injector.js";
import { createLogger } from "./logger.js";
import { WhisperRunner } from "./whisper-runner.js";
import { WhisperServer } from "./whisper-server.js";
import { StreamingWhisperRunner, PartialTranscript, PassTiming, StallInfo } from "./streaming-whisper-runner.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { LLMServer } from "./llm-server.js";
import { buildCleanupPrompt } from "./utils/prompt-template.js";
import { buildInitialPrompt } from "./utils/initial-prompt.js";
import { waitForEventOrTimeout } from "./utils/wait-for-event.js";
import { restartRequiredFields } from "./utils/restart-required.js";
import { checkAccessibility, checkAutomationViaProbe, checkMicrophone } from "./permissions.js";
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
const VAD_MODEL = join(BIN_DIR, "ggml-silero-v6.2.0.bin");

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");

async function main(): Promise<void> {
  // Single-instance lock: if another open-flow is already running, exit
  // immediately instead of spinning up a duplicate menubar icon, llama-server,
  // PTT NSEvent monitor, etc. This happens when the user reinstalls via
  // `cp -R` while the old instance is still alive, or double-clicks the .app
  // in Finder. Must be called BEFORE app.whenReady().
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  await app.whenReady();

  const preferencesStore = new PreferencesStore(PREFS_PATH);
  const modelManager = new ModelManager();
  let prefs = await preferencesStore.load();

  const logger = createLogger({ dir: LOG_DIR, debug: prefs.debugLogging, maxBytes: 5 * 1024 * 1024 });
  await logger.info("app starting", { setupComplete: prefs.setupComplete });

  // Async event handlers (e.g. ptt.on("stop")) that throw produce a rejected
  // promise nobody awaits; Node would drop it silently. Log it so such
  // failures leave a trace instead of just a stuck UI.
  process.on("unhandledRejection", (reason) => {
    // Registering a listener suppresses Node's default stderr print, so keep it.
    // eslint-disable-next-line no-console
    console.error("unhandled rejection", reason);
    // Swallow logger failures: a rejection here would re-enter this handler.
    void logger
      .error("unhandled rejection", {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      })
      .catch(() => undefined);
  });

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

  // Built before the wizard (and before the slow model loads) so everything
  // that needs it later — the menubar callbacks now, the wizard's permission
  // checks in a later step — can rely on it already existing. Constructing it
  // only loads the native addon; the NSEvent monitor is installed by
  // ptt.start(), far below, so the wizard's behaviour is unchanged.
  let ptt: PTTManager;
  try {
    ptt = new PTTManager({ appRoot: APP_ROOT, isPackaged: app.isPackaged });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logger.error("PTT native addon failed to load", { message });
    dialog.showErrorBox(
      "open-flow can't start",
      "The keyboard listener failed to load. Reinstall the app or report this on GitHub.\n\n" + message,
    );
    app.exit(1);
    return;
  }
  ptt.on("ready", () => {
    void logger.info("PTT armed (in-process NSEvent monitor)");
  });
  ptt.on("trustRequired", () => {
    void logger.error("PTT requires Accessibility — prompt shown to user");
  });

  // First-launch: run setup wizard until setupComplete=true
  if (!prefs.setupComplete) {
    const wizard = new SetupWizard({ modelManager, preferencesStore, accessibility: ptt });
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

  // Snapshot of the prefs the models/servers below are started with. The
  // Settings window compares against it to flag restart-required changes.
  const bootPrefs = { ...prefs };

  // The menubar icon appears now, before the slow model loads below, so the
  // user sees the app is alive. Everything its callbacks touch (`ptt`,
  // `prefsWindow`, `prefs`) is declared above this point.
  const prefsWindow = new PreferencesWindow({
    modelManager,
    preferencesStore,
    restartStatus: async () => restartRequiredFields(bootPrefs, await preferencesStore.load()),
  });
  // Assigned near the bottom, once the PTT handlers are registered.
  let pttArmer: PttArmer | null = null;
  const menubar = new MenubarApp(
    {
      onToggleEnabled: () => {
        if (menubar.isEnabled()) {
          // Resuming: re-arm (or resume waiting for Accessibility).
          pttArmer ? pttArmer.arm() : ptt.start();
        } else {
          pttArmer?.stop();
          ptt.stop();
        }
      },
      onOpenSettings: () => {
        void prefsWindow.open();
      },
      // Until the Settings window grows a Permissions section, jump straight
      // to the Accessibility pane — the permission people most often miss.
      onCheckPermissions: () => {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
      },
      onOpenLogs: () => {
        void shell.openPath(LOG_DIR);
      },
      onRelaunch: () => {
        app.relaunch();
        app.quit();
      },
      onQuit: () => app.quit(),
    },
    { version: app.getVersion() },
  );
  menubar.create();
  menubar.setStatus("Loading models…");
  // Keep the in-memory snapshot in sync so `arm` (language, dictionary) reads
  // fresh values and debug logging toggles without a restart. Note: the
  // llama-server warmup prompt stays on the boot language; that is only a cache
  // warm-up, not part of the per-dictation cleanup prompt.
  prefsWindow.onSaved((next) => {
    prefs = next;
    logger.setDebug(next.debugLogging);
  });

  const mic = await checkMicrophone();
  const acc = checkAccessibility(ptt);
  const automation = await checkAutomationViaProbe();
  await logger.info("permissions", { mic, accessibility: acc, automation });

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
      vadModelPath: VAD_MODEL,
      chunkIntervalMs: 1500,
      // Keep the Metal GPU warm while idle so the first chunk after a pause
      // doesn't pay the ~10x cold-start ramp (the powerSaveBlocker prevents
      // process suspension but not GPU clock-down).
      keepaliveIntervalMs: 20_000,
      // Watchdog: a whisper_full pass occasionally hangs forever (Metal/GPU
      // stall), holding the inference mutex — that froze dictation AND blocked
      // app quit (force-quit territory). 30s is well above the worst legit cold
      // pass (~11s observed); past it we treat the pass as hung and relaunch.
      passTimeoutMs: 30_000,
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
    // A hung whisper_full pass poisons the single in-process whisper context and
    // can't be recovered in-process (it blocks quit too). Relaunch with a fresh
    // process/GPU context — converts an unrecoverable freeze into an auto-restart.
    streamingWhisper.on("stall", (s: StallInfo) => {
      void logger.error("whisper pass stalled — relaunching app", {
        phase: s.phase,
        timeoutMs: s.timeoutMs,
      });
      app.relaunch();
      app.exit(0);
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
    menubar.setStatus("Starting cleanup model…");
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
  const injector = createDefaultTextInjector(logger);
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
    inject: async (text, signal) => injector.inject(text, signal),
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
    // Stop the streaming chunk loop too, or a partial from this dictation
    // leaks into the overlay of the next one.
    if (streamingWhisper) streamingWhisper.cancel();
    coordinator.cancel();
    void mediaController.resume().catch(swallowMcError("resume"));
  });

  // Diagnostic: log every raw NSEvent we receive so duplicate-fire bugs
  // can be diagnosed from the log. `detail` carries the keyCode behind a CHORD
  // (which distinguishes a genuine Option shortcut from a spurious one) and the
  // cached-vs-live comparison behind a DESYNC.
  ptt.on("rawEvent", (state: string, detail?: string) => {
    void logger.info("PTT rawEvent", { state, detail });
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
      // Read language + dictionary synchronously from last-known prefs — the
      // chunk loop needs them right away. (Like language, the dictionary's
      // biasing reflects the launch-time value; the hot, always-correct layer
      // is the dictionary CORRECTION applied at finalize in the coordinator.)
      const { prompt, dropped } = buildInitialPrompt(prefs.dictionary);
      if (dropped.length > 0) {
        void logger.info("initial_prompt truncated", { dropped });
      }
      streamingWhisper.start(prefs.language, prompt);
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
      // 500ms safety fallback in case the renderer hangs / crashes before
      // sending the ack — better to lose a partial sample than to wedge. The
      // helper also drops its listener on timeout and clears the timer on EOS:
      // a leftover once() listener would not steal a later EOS (emit reaches
      // every listener), but listeners would pile up after repeated timeouts
      // (MaxListenersExceededWarning) and the 500ms timer would stay pending.
      const eos = waitForEventOrTimeout(ipcMain, "audio:end-of-stream", 500);
      recorderWin.webContents.send("audio:stop");
      const gotEos = await eos;
      void logger.info("audio EOS received", { ms: Date.now() - eosT0, timedOut: !gotEos });
      const samples = orchestrator.snapshot();
      const currentPrefs = await preferencesStore.load();
      await coordinator.finishWithAudio(samples, SAMPLE_RATE, currentPrefs.language, {
        useLlmCleanup: currentPrefs.useLlmCleanup,
        spokenPunctuation: currentPrefs.spokenPunctuation,
        dictionary: currentPrefs.dictionary,
      });
      menubar.setStatus("Ready");
    } catch (err) {
      // Reset FIRST: logger.error can reject (disk full, unwritable dir) and
      // must never stop us from un-wedging the pipeline. finishWithAudio
      // normally handles its own errors, so this mostly catches what escapes
      // BEFORE it (EOS wait, snapshot, prefs load), but it can also rethrow
      // if the logger throws inside its catch.
      // EventEmitter ignores a rejected async handler, so without this the
      // coordinator would stay in "recording" and the overlay on "Recording…"
      // forever, with streaming finalize() never called.
      orchestrator.reset();
      if (streamingWhisper) streamingWhisper.cancel();
      coordinator.cancel();
      menubar.setStatus("Ready");
      void logger
        .error("stop handler failed", {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        .catch(() => undefined);
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
    menubar.setStatus("Ready");
  });

  // Arm push-to-talk without blocking: if Accessibility is missing, show the
  // standard macOS prompt once, say so in the tray and poll until it is granted.
  pttArmer = createPttArmer({
    isTrusted: () => ptt.isTrusted(),
    start: () => ptt.start(),
    intervalMs: 2000,
    onState: (state) => {
      void logger.info("PTT arming", { state });
      switch (state) {
        case "armed":
          menubar.setPermissionHint(null);
          menubar.setStatus("Ready — hold ⌥ to dictate");
          break;
        case "waiting":
          menubar.setStatus("Needs Accessibility permission");
          menubar.setPermissionHint(
            "Open System Settings › Privacy & Security › Accessibility and turn on open-flow",
          );
          break;
        case "armed-after-grant":
          menubar.setPermissionHint(null);
          menubar.setStatus("Ready — if Option doesn't respond, choose Relaunch open-flow");
          break;
        case "relaunch-needed":
          menubar.setPermissionHint(null);
          menubar.setStatus("Permission granted — relaunch to activate");
          break;
      }
    },
  });
  // Respect a "Pause dictation" the user may have chosen while models loaded.
  if (menubar.isEnabled()) {
    if (!ptt.isTrusted()) ptt.requestTrust(); // macOS prompt, once
    pttArmer.arm();
  } else {
    menubar.setStatus("Paused");
  }

  app.on("will-quit", () => {
    pttArmer?.stop();
    ptt.stop();
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    // shutdown(), NOT release(): release() blocks on the native inference mutex,
    // which a hung pass holds forever — that would freeze quit. The OS reclaims
    // the model/GPU on process exit.
    if (streamingWhisper) streamingWhisper.shutdown();
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
