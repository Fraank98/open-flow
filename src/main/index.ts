import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { PipelineCoordinator } from "./pipeline-coordinator.js";
import { AudioOrchestrator } from "./audio-orchestrator.js";
import { HotkeyManager } from "./hotkey-manager.js";
import { OverlayWindow } from "./overlay-window.js";
import { MenubarApp } from "./menubar-app.js";
import { createDefaultTextInjector } from "./text-injector.js";
import { createLogger } from "./logger.js";
import { WhisperRunner } from "./whisper-runner.js";
import { LLMCleaner } from "./llm-cleaner.js";
import { checkAccessibilityViaProbe, checkMicrophone } from "./permissions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_ROOT = join(__dirname, "..", "..");

const HOTKEY_ACCELERATOR = "Alt+Space";
const SAMPLE_RATE = 16_000;
const LANGUAGE = "auto";

const WHISPER_BIN = join(APP_ROOT, "resources", "bin", "whisper-cli");
const LLAMA_BIN = join(APP_ROOT, "resources", "bin", "llama-cli");
const WHISPER_MODEL = join(APP_ROOT, "test", "fixtures", "models", "ggml-tiny.bin");
const LLM_MODEL = join(APP_ROOT, "test", "fixtures", "models", "qwen2.5-0.5b-instruct-q4_k_m.gguf");

const LOG_DIR = join(homedir(), "Library", "Logs", "open-flow");

async function main(): Promise<void> {
  await app.whenReady();

  const logger = createLogger({ dir: LOG_DIR, debug: !!process.env.OPEN_FLOW_DEBUG, maxBytes: 5 * 1024 * 1024 });
  await logger.info("app starting");

  // Permissions check (informational only; do not block)
  const mic = await checkMicrophone();
  const acc = await checkAccessibilityViaProbe();
  await logger.info("permissions", { mic, accessibility: acc });

  const whisper = new WhisperRunner({
    binaryPath: WHISPER_BIN,
    modelPath: WHISPER_MODEL,
    timeoutMs: 60_000,
  });
  const llm = new LLMCleaner({
    binaryPath: LLAMA_BIN,
    modelPath: LLM_MODEL,
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

  // Recorder hidden window
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
    // Copy because the buffer is reused by IPC
    const chunk = new Float32Array(view.length);
    chunk.set(view);
    orchestrator.appendChunk(chunk);
  });
  ipcMain.on("audio:error", async (_e, message: string) => {
    await logger.error("recorder error", { message });
  });

  const hotkey = new HotkeyManager({ accelerator: HOTKEY_ACCELERATOR });

  const menubar = new MenubarApp({
    onToggleEnabled: () => {
      if (menubar.isEnabled()) {
        hotkey.register();
      } else {
        hotkey.unregister();
      }
    },
    onQuit: () => app.quit(),
  });
  menubar.create();

  hotkey.on("start", () => {
    orchestrator.reset();
    coordinator.startRecording();
    recorderWin.webContents.send("audio:start");
    menubar.setStatus("Recording…");
  });
  hotkey.on("stop", async () => {
    recorderWin.webContents.send("audio:stop");
    // Wait a moment for the last chunk to arrive
    await new Promise((r) => setTimeout(r, 250));
    const samples = orchestrator.snapshot();
    await coordinator.finishWithAudio(samples, SAMPLE_RATE, LANGUAGE);
    hotkey.reset();
    menubar.setStatus("Idle");
  });

  const reg = hotkey.register();
  if (!reg.ok) {
    await logger.error("hotkey registration failed", { reason: reg.reason, accelerator: HOTKEY_ACCELERATOR });
  } else {
    await logger.info("hotkey registered", { accelerator: HOTKEY_ACCELERATOR });
  }

  app.on("will-quit", () => {
    hotkey.unregister();
    overlay.destroy();
    menubar.destroy();
  });

  // Menubar app — stay alive even with no windows. macOS doesn't auto-quit
  // when all windows close, so no preventDefault is needed.
  app.on("window-all-closed", () => {
    // intentional no-op
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  app.exit(1);
});
