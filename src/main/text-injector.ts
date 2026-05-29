import { clipboard } from "electron";
import { exec } from "node:child_process";

export interface InjectorDeps {
  readClipboard: () => string;
  writeClipboard: (text: string) => void;
  runPaste: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface InjectResult {
  pasted: boolean;
  reason?: string;
}

export class TextInjector {
  constructor(private readonly deps: InjectorDeps) {}

  async inject(text: string): Promise<InjectResult> {
    const prior = this.deps.readClipboard();
    this.deps.writeClipboard(text);
    try {
      await this.deps.runPaste();
    } catch (err) {
      // Leave text in clipboard so the user can paste manually
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
    runPaste: () =>
      new Promise<void>((resolve, reject) => {
        exec(
          `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
          (err) => (err ? reject(err) : resolve()),
        );
      }),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  });
}
