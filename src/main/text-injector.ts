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
