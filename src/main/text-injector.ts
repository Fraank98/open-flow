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
    await this.deps.sleep(150);
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
