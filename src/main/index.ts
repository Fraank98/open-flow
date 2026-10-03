import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, powerSaveBlocker, shell } from "electron";
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
import { readyStateForArmer } from "./utils/ready-state.js";
import { waitForEventOrTimeout } from "./utils/wait-for-event.js";
import { toWizardPipelineState } from "./utils/wizard-pipeline-state.js";
import { restartRequiredFields } from "./utils/restart-required.js";
import { checkAccessibility, checkAutomationViaProbe, checkMicrophone, type PermissionStatus } from "./permissions.js";
import { PreferencesStore } from "./preferences-store.js";
import { ModelManager } from "./model-manager.js";
import { getModelById, tierForModels } from "./model-catalog.js";
import { getModelsDir, modelFilePath } from "./utils/model-paths.js";
import { SetupWizard } from "./setup-wizard.js";
import { PreferencesWindow } from "./preferences-window.js";
import { MediaController, createDefaultScripter } from "./media-control.js";
import { AxContextReader } from "./ax-context-reader.js";
import { parse as parseConversation } from "./utils/conversation-parser.js";
import { ReplyChatClient } from "./reply-chat-client.js";
import { ReplyClassifier } from "./reply-classifier.js";
import { ReplyGenerator, GENERATOR_PREFIX } from "./reply-generator.js";
import { filterVariants } from "./utils/variant-filter.js";
import { ReplyServerManager } from "./reply-server-manager.js";
import { ReplyCoordinator, hasExplicitProposal, VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR } from "./reply-coordinator.js";
import { HotkeyManager } from "./hotkey-manager.js";
import { reconcileReplyAccelerator } from "./utils/reply-hotkey.js";
import { IpcChannels } from "../shared/ipc-channels.js";
import type { ReplyUiStatus } from "./preferences-window.js";

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

// The reply model lives in its own llama-server: a different model, and the
// dictation cleanup stays untouched in the critical path (decision 5).
// 18080 = cleanup, 18081 = whisper-server fallback, 18082 = replies.
const REPLY_PORT = 18082;
const REPLY_ENDPOINT = `http://127.0.0.1:${REPLY_PORT}`;
const REPLY_CONTEXT_SIZE = 3072;
const REPLY_CLASSIFY_TIMEOUT_MS = 8_000;
const REPLY_GENERATE_TIMEOUT_MS = 10_000;

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");
const PREFS_PATH = join(homedir(), "Library", "Application Support", "open-flow", "preferences.json");

/** Set inside main() once both llama-server managers exist, so the fatal
 *  startup-error handler at the bottom of this file can stop them before
 *  app.exit(1) — app.exit() never emits will-quit, so nothing else would ask
 *  either server to release its model / free its port before a relaunch
 *  (found by review: four things between server-start and the end of main()
 *  can throw — ptt.start(), the trust dialog, logger.error, menubar.create()
 *  — and any of them left both llama-server processes running with their
 *  models in RAM and port 18082 already occupied). */
let stopServers: () => void = () => {};

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

  // First-launch: run setup wizard until setupComplete=true. run() resolves as
  // soon as the models are downloaded; the window then stays open on its last
  // step while the rest of the boot below goes on (see setReadyState). It is
  // declared before everything that uses it later (coordinator and PTT-arming
  // callbacks), so none of those closures can hit it in the TDZ.
  let wizard: SetupWizard | null = null;
  if (!prefs.setupComplete) {
    wizard = new SetupWizard({ modelManager, preferencesStore, accessibility: ptt });
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
    // Resume at the download step with a reason, not at "welcome" with no context.
    await preferencesStore.update({ setupComplete: false, setupStep: "download", setupReason: "missing-model" });
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
    // The download step needs a tier: use the one these models belong to (the
    // wizard falls back to the tier chooser when there is none).
    await preferencesStore.update({
      setupComplete: false,
      setupStep: "download",
      setupReason: "missing-model",
      setupTierId: tierForModels(prefs.whisperModelId, prefs.llmModelId)?.id ?? prefs.setupTierId,
    });
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
  // Last Automation probe result: the probe runs osascript (and may raise the
  // macOS prompt), so Settings only re-runs it when the user clicks "Check again".
  let automationStatus: PermissionStatus = "unknown";
  // Replaced by the reply-suggestions wiring further down.
  let replyUiStatus: () => ReplyUiStatus = () => ({
    serverState: "off",
    serverError: null,
    hotkeyRegistered: false,
    nativeOk: false,
    lastBlockedBundleId: null,
    booting: true,
  });
  const prefsWindow = new PreferencesWindow({
    modelManager,
    preferencesStore,
    replyStatus: () => replyUiStatus(),
    restartStatus: async () => restartRequiredFields(bootPrefs, await preferencesStore.load()),
    permissionsStatus: async (probeAutomation) => {
      if (probeAutomation) automationStatus = await checkAutomationViaProbe();
      return {
        mic: await checkMicrophone(),
        accessibility: checkAccessibility(ptt),
        automation: automationStatus,
      };
    },
    logDir: LOG_DIR,
    version: app.getVersion(),
  });
  // The last "Ready — …" line the armer chose, so after a dictation the tray
  // goes back to it instead of a generic "Ready" (which would drop the
  // "if Option doesn't respond, choose Relaunch" advice).
  // Declared up here, with the other state the handlers close over, so no
  // handler can reach it before it exists.
  let readyStatus = "Ready";

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
          // The "needs Accessibility" hint is moot while paused; resuming
          // re-arms, and the armer re-adds it if it is still needed.
          menubar.setPermissionHint(null);
          if (wizard?.isOpen()) wizard.setReadyState("paused");
        }
      },
      onOpenSettings: () => {
        void prefsWindow.open();
      },
      // The Permissions list lives on the General tab of Settings.
      onCheckPermissions: () => {
        void prefsWindow.open("general");
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
  // create() hides the dock icon, which drops focus from a wizard window that is
  // still open (the first-run case): bring it back.
  if (wizard?.isOpen()) wizard.focus();

  // The tray's Quit/Relaunch exist from here on, while the slow loads below can
  // take tens of seconds — so the cleanup must be registered NOW, not at the end
  // of boot, or quitting during "Loading models…" would leave llama-server
  // orphaned on :18080 (it is a plain, non-detached child). The things it tears
  // down are created later, and a `const` read before its declaration throws a
  // ReferenceError (TDZ), so each is a `let` declared here as null and assigned
  // once it exists; the handler skips whatever isn't there yet.
  let streamingWhisper: StreamingWhisperRunner | null = null;
  let bootWhisperServer: WhisperServer | null = null;
  let bootLlmServer: LLMServer | null = null;
  let bootReplyServer: ReplyServerManager | null = null;
  // Set once the reply-suggestions wiring below exists.
  let bootReplyCleanup: (() => void) | null = null;
  let bootOverlay: OverlayWindow | null = null;
  // Set by the handler so a boot step still in flight doesn't start a server
  // after cleanup already ran.
  let quitting = false;
  app.on("will-quit", () => {
    quitting = true;
    pttArmer?.stop();
    ptt.stop();
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    // shutdown(), NOT release(): release() blocks on the native inference mutex,
    // which a hung pass holds forever — that would freeze quit. The OS reclaims
    // the model/GPU on process exit.
    streamingWhisper?.shutdown();
    bootWhisperServer?.stop();
    bootLlmServer?.stop();
    bootReplyCleanup?.();
    bootReplyServer?.stop();
    bootOverlay?.destroy();
    menubar.destroy();
  });
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
  await logger.info("permissions", { mic, accessibility: acc });
  // Not awaited: with the macOS Automation prompt left unanswered the probe
  // blocks (up to its timeout), and boot must not sit on "Loading models…" for
  // it. It still raises the prompt early, and the result only feeds Settings.
  void checkAutomationViaProbe().then(async (result) => {
    // A probe the user ran from Settings meanwhile is newer than this one.
    if (automationStatus === "unknown") automationStatus = result;
    await logger.info("automation probe", { automation: result });
  });

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

  // Both constructed here, ahead of the streaming-whisper block below, on
  // purpose: its own stall handler references BOTH llmServer and
  // replyServerManager, and a `const` referenced by a closure that is
  // registered before the `const`'s own declaration line throws
  // ReferenceError until that line executes (TDZ) — found by review, and
  // (round 2) the same trap existed for llmServer too, left half-closed when
  // only replyServerManager was moved. Neither construction has any
  // dependency on anything computed below this point (llmServer needs only
  // `llmModelPath` and `prefs.language`, both already resolved above;
  // replyServerManager needs only `modelManager` and `logger`), so moving
  // both ahead of the closure that captures them removes the race instead of
  // papering over it with an optional-chained call.
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
  const replyServerManager = new ReplyServerManager({
    createServer: (modelPath) =>
      new LLMServer({
        binaryPath: LLAMA_SERVER_BIN,
        modelPath,
        port: REPLY_PORT,
        contextSize: REPLY_CONTEXT_SIZE,
        startupTimeoutMs: 90_000,
        // The generator's fixed instruction prefix, so it is already in the
        // KV cache when the first hotkey lands.
        warmupPrompt: GENERATOR_PREFIX,
        keepaliveMs: 20_000,
      }),
    modelManager,
    logger,
  });
  // Both server managers exist now: from here on, a fatal startup error can
  // release the model RAM and the reply port instead of leaking them across
  // app.exit(1) (Important 3 — see the module-level declaration above).
  stopServers = () => { llmServer.stop(); replyServerManager.stop(); };
  bootLlmServer = llmServer;
  bootReplyServer = replyServerManager;

  // Streaming Whisper via the in-process native addon. Model loads once
  // into a whisper_context that stays in RAM; each utterance is a
  // start → feedSamples* → processChunk* → finalize cycle.
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
      // app.exit() does not emit will-quit, so the child llama-server
      // processes (dictation cleanup, and — if the reply feature is on —
      // the second, larger model) are not asked to stop by anything else:
      // without this they outlive this process with their RAM still held,
      // and the relaunched instance finds their ports already occupied.
      llmServer.stop();
      replyServerManager.stop();
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
  bootWhisperServer = whisperServer;
  if (!streamingWhisper && !quitting) {
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

  // llmServer itself is constructed earlier, above the streaming-whisper
  // block (see the comment there) — it only gets started here.
  // Only run llama-server when LLM cleanup is enabled. With it off (whisper-only
  // mode) the model would just sit in RAM and its keepalive would contend with
  // whisper for the GPU every 20s — pure waste. Toggling the pref on at runtime
  // takes effect after a restart (see the resilient clean() wiring below).
  if (quitting) return;
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

  // Global busy flag: prevent a second 'stop' from firing while a pipeline
  // is still running. The coordinator has its own state guard but stop
  // events are debounced through async setTimeout(250) so two stops can
  // both pass the guard if they happen in the same tick.
  let pipelineBusy = false;

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
  bootOverlay = overlay;
  await overlay.create();
  coordinator.onStateChange((state) => {
    if (wizard?.isOpen()) wizard.sendPipelineState(toWizardPipelineState(state));
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

  // ── Reply suggestions (optional feature, off by default) ──
  // Degradation L6: if the addon cannot be loaded the feature disables itself
  // for the session and the rest of the app starts normally.
  let axReader: AxContextReader | null = null;
  try {
    axReader = new AxContextReader({ appRoot: APP_ROOT, isPackaged: app.isPackaged, logger });
    await logger.info("ax_context addon loaded");
  } catch (err) {
    await logger.error("ax_context addon not loadable — reply suggestions disabled for this session", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // replyServerManager itself is constructed earlier, above the streaming-
  // whisper block (see the comment there) — only its client/classifier/
  // generator need to wait for this point.
  // The port is fixed, so one client is enough for the app's lifetime; the
  // manager's isReady() is what gates the calls.
  const replyClient = new ReplyChatClient({ endpoint: REPLY_ENDPOINT });
  const replyClassifier = new ReplyClassifier({ client: replyClient, timeoutMs: REPLY_CLASSIFY_TIMEOUT_MS, logger });
  const replyGenerator = new ReplyGenerator({ client: replyClient, timeoutMs: REPLY_GENERATE_TIMEOUT_MS, logger });

  let replyHotkeyRegistered = false;
  const replyCoordinator = axReader === null ? null : new ReplyCoordinator({
    reader: axReader,
    parse: parseConversation,
    classify: (input) => replyClassifier.classify(input),
    generate: (input) => replyGenerator.generate(input),
    filterVariants,
    overlay,
    shortcuts: {
      register: (accelerator, cb) => globalShortcut.register(accelerator, cb),
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    server: {
      isReady: () => replyServerManager.isReady(),
      getState: () => replyServerManager.getState(),
      recover: () => replyServerManager.recover(),
    },
    inject: (text) => injector.inject(text),
    copyToClipboard: (text) => clipboard.writeText(text),
    loadPrefs: async () => {
      const p = await preferencesStore.load();
      return {
        enabled: p.replySuggestionsEnabled,
        userDisplayName: p.userDisplayName,
        appsMode: p.replyAppsMode,
        apps: p.replyApps,
      };
    },
    // Mutual exclusion in the other direction: no reply run while a dictation
    // is anywhere but idle.
    dictationBusy: () => pipelineBusy || coordinator.getState() !== "idle",
    logger,
    onTrustRequired: () => {
      dialog.showMessageBox({
        type: "warning",
        title: "open-flow needs Accessibility access",
        message: "Reply suggestions read the conversation under the mouse",
        detail: "Open System Settings → Privacy & Security → Accessibility and enable open-flow.",
        buttons: ["Open System Settings", "Close"],
        defaultId: 0,
        cancelId: 1,
      }).then((r) => {
        if (r.response === 0) {
          shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
        }
      }).catch(() => undefined);
    },
    // Wired because the Task 1 experiment came out MITIGAZIONE — see the
    // module's own doc comment on hasExplicitProposal.
    preGate: hasExplicitProposal,
  });

  // The reply hotkey is an impulse, not a toggle: HotkeyManager alternates
  // start/stop, so reset() right after 'start' makes every press a start.
  function wireReplyHotkeyStart(hk: HotkeyManager): void {
    hk.on("start", () => {
      hk.reset();
      if (replyCoordinator) void replyCoordinator.onHotkey();
    });
  }
  let replyAccelerator = reconcileReplyAccelerator(prefs.replySuggestionsHotkey, "").accelerator;
  let replyHotkey = new HotkeyManager({ accelerator: replyAccelerator });
  wireReplyHotkeyStart(replyHotkey);

  // Reads the saved accelerator fresh every time (same "read prefs from disk
  // on every reconcile" pattern as the coordinator's own loadPrefs), so a
  // hotkey saved in Preferences takes effect without a restart.
  // HotkeyManager's accelerator is immutable once constructed (opts is
  // readonly): a change can only take effect by unregistering the old
  // manager and constructing a fresh one — reconcileReplyAccelerator (tested
  // in utils/reply-hotkey.ts) decides the value and whether that swap is
  // needed; this function only carries out the swap and the register/
  // unregister side effects.
  async function applyReplyHotkey(): Promise<void> {
    const saved = (await preferencesStore.load()).replySuggestionsHotkey;
    const { accelerator, rebuild } = reconcileReplyAccelerator(saved, replyAccelerator);
    if (rebuild) {
      if (replyHotkeyRegistered) {
        replyHotkey.unregister();
        replyHotkeyRegistered = false;
      }
      replyAccelerator = accelerator;
      replyHotkey = new HotkeyManager({ accelerator: replyAccelerator });
      wireReplyHotkeyStart(replyHotkey);
    }

    const wanted = replyServerManager.getState() === "ready" && replyCoordinator !== null;
    if (wanted && !replyHotkeyRegistered) {
      const r = replyHotkey.register();
      replyHotkeyRegistered = r.ok;
      void logger.info("reply hotkey", { accelerator: replyAccelerator, registered: r.ok });
    } else if (!wanted && replyHotkeyRegistered) {
      replyHotkey.unregister();
      replyHotkeyRegistered = false;
      void logger.info("reply hotkey released");
    }
  }
  replyServerManager.onStateChange((state) => {
    void applyReplyHotkey();
    if (state !== "ready" && replyCoordinator) replyCoordinator.dismiss("quit");
  });
  replyServerManager.onDownloadProgress((p) => {
    void logger.debug("reply model download", { bytes: p.bytes, total: p.total });
  });

  // Overlay → main, same pattern as pipeline:cancel.
  ipcMain.on(IpcChannels.ReplyChoose, (_e, id: number) => {
    if (replyCoordinator && Number.isInteger(id)) void replyCoordinator.accept(id);
  });
  ipcMain.on(IpcChannels.ReplyDismiss, () => { replyCoordinator?.dismiss("click"); });
  ipcMain.on(IpcChannels.ReplyHover, () => { replyCoordinator?.onHover(); });

  // The Settings window reads the reply state through this; until the block
  // above ran (it can open while models still load) the stub reports `booting`.
  replyUiStatus = (): ReplyUiStatus => ({
    serverState: replyServerManager.getState(),
    serverError: replyServerManager.lastError(),
    hotkeyRegistered: replyHotkeyRegistered,
    nativeOk: axReader !== null,
    lastBlockedBundleId: replyCoordinator?.lastBlockedBundleId() ?? null,
    booting: false,
  });
  // Quit-time teardown of everything above (the will-quit handler is registered
  // much earlier, before these objects exist).
  bootReplyCleanup = () => {
    replyCoordinator?.dismiss("quit");
    if (replyHotkeyRegistered) replyHotkey.unregister();
    for (const acc of [...VARIANT_ACCELERATORS, ESCAPE_ACCELERATOR]) globalShortcut.unregister(acc);
  };

  prefsWindow.onSaved((next) => {
    // Mirrors the startup guard below (`prefs.replySuggestionsEnabled &&
    // replyCoordinator`): without `replyCoordinator !== null` here, checking
    // the box when the native addon failed to load starts the 2.5-5 GB
    // model server for a feature applyReplyHotkey can never register a
    // hotkey for (found by review — Important 2).
    void replyServerManager.apply({ enabled: next.replySuggestionsEnabled && replyCoordinator !== null, replyModelId: next.replyModelId })
      .then(applyReplyHotkey)
      .catch((err: unknown) => logger.error("reply server apply failed", {
        message: err instanceof Error ? err.message : String(err),
      }));
  });

  // `quitting` is checked like for whisper/llama: a quit during boot must not
  // start a model server that the will-quit teardown has already passed.
  if (prefs.replySuggestionsEnabled && replyCoordinator && !quitting) {
    // Not awaited: the app must not wait for a 2.5-5 GB model to load.
    void replyServerManager.apply({ enabled: true, replyModelId: prefs.replyModelId })
      .then(applyReplyHotkey)
      .catch((err: unknown) => logger.error("reply server start failed", {
        message: err instanceof Error ? err.message : String(err),
      }));
  } else if (!quitting) {
    await logger.info("reply suggestions off — no second llama-server", {
      enabled: prefs.replySuggestionsEnabled, nativeOk: axReader !== null,
    });
  }

  // Diagnostic: log every raw NSEvent we receive so duplicate-fire bugs
  // can be diagnosed from the log. `detail` carries the keyCode behind a CHORD
  // (which distinguishes a genuine Option shortcut from a spurious one) and the
  // cached-vs-live comparison behind a DESYNC.
  ptt.on("rawEvent", (state: string, detail?: string) => {
    void logger.info("PTT rawEvent", { state, detail });
  });

  ptt.on("arm", () => {
    replyCoordinator?.onDictationArm();
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
      menubar.setStatus(readyStatus);
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
      menubar.setStatus(readyStatus);
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
    menubar.setStatus(readyStatus);
  });

  // Arm push-to-talk without blocking: if Accessibility is missing, show the
  // standard macOS prompt once, say so in the tray and poll until it is granted.
  pttArmer = createPttArmer({
    isTrusted: () => ptt.isTrusted(),
    start: () => ptt.start(),
    intervalMs: 2000,
    onState: (state) => {
      void logger.info("PTT arming", { state });
      // Whatever the state, the wizard's last step must show it (it would
      // otherwise sit on "Starting up…" while blocked on Accessibility).
      if (wizard?.isOpen()) wizard.setReadyState(readyStateForArmer(state));
      switch (state) {
        case "armed":
          menubar.setPermissionHint(null);
          readyStatus = "Ready — hold ⌥ to dictate";
          menubar.setStatus(readyStatus);
          break;
        case "waiting":
          menubar.setStatus("Needs Accessibility permission");
          menubar.setPermissionHint(
            "Open System Settings › Privacy & Security › Accessibility and turn on open-flow",
          );
          break;
        case "armed-after-grant":
          menubar.setPermissionHint(null);
          readyStatus = "Ready — if Option doesn't respond, choose Relaunch open-flow";
          menubar.setStatus(readyStatus);
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
    if (wizard?.isOpen()) wizard.setReadyState("paused");
  }

  app.on("window-all-closed", () => {
    // intentional no-op — menubar app stays alive
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  // app.exit(1) never emits will-quit: without this, a throw anywhere
  // between server-start and the end of main() (ptt.start(), the trust
  // dialog, logger.error, menubar.create() all can throw) leaves both
  // llama-server processes running with their models in RAM and port 18082
  // occupied, so the next launch can't start its own reply server (found by
  // review — Important 3).
  stopServers();
  app.exit(1);
});
