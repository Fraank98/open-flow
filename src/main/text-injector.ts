import { clipboard } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * How long to give the ⌘V keystroke before giving up. System Events can go
 * unresponsive on its own (observed in production logs as `media-control
 * pause failed` WARNs at the same instants) and an un-timed-out osascript
 * call then never resolves — the exec callback simply never fires, so
 * `inject()` never settles and PipelineCoordinator.finishWithAudio awaits it
 * forever with the overlay stuck on "Pasting…". 3000ms matches the timeout
 * already used for AppleScript calls in media-control.ts. On timeout (or an
 * external abort, see `signal` below) Node kills the child process itself —
 * that's the point: no stray ⌘V fires later into whatever app happens to be
 * focused by then.
 */
export const PASTE_TIMEOUT_MS = 3000;

export interface InjectorDeps {
  readClipboard: () => string;
  writeClipboard: (text: string) => void;
  runPaste: (signal?: AbortSignal) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface InjectResult {
  pasted: boolean;
  reason?: string;
}

export class TextInjector {
  constructor(private readonly deps: InjectorDeps) {}

  async inject(text: string, signal?: AbortSignal): Promise<InjectResult> {
    const prior = this.deps.readClipboard();
    this.deps.writeClipboard(text);
    try {
      await this.deps.runPaste(signal);
    } catch (err) {
      // Leave text in clipboard so the user can paste manually. Covers both
      // a genuine paste failure and a timeout/abort kill — either way the
      // transcript must NOT be clobbered by restoring `prior`.
      return {
        pasted: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // Wait long enough for the receiving app to actually READ the clipboard
    // before we restore. `runPaste` resolves when the ⌘V event has been SENT
    // (osascript exits), not when the target app has processed it. Slow
    // receivers (Electron/Chromium with async paste handlers, or any app
    // while the system is under whisper+llama load) can lag 100-300ms before
    // reading the clipboard. With 150ms we'd intermittently restore `prior`
    // first → the app would then read it and paste the OLD clipboard content
    // instead of the transcript. 500ms gives generous headroom; the user
    // doesn't perceive the extra latency because the original clipboard is
    // already overwritten anyway.
    await this.deps.sleep(500);
    this.deps.writeClipboard(prior);
    return { pasted: true };
  }
}

export function createDefaultTextInjector(): TextInjector {
  return new TextInjector({
    readClipboard: () => clipboard.readText(),
    writeClipboard: (text) => clipboard.writeText(text),
    runPaste: async (signal) => {
      await execFileP(
        "osascript",
        ["-e", `tell application "System Events" to keystroke "v" using command down`],
        { timeout: PASTE_TIMEOUT_MS, signal },
      );
    },
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  });
}
