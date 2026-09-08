import { getModelById } from "./model-catalog.js";
import type { ModelDescriptor } from "./utils/model-paths.js";
import type { ReplyServerState } from "../shared/reply-types.js";
import type { Logger } from "./logger.js";

/** The subset of LLMServer the manager needs; a factory builds the real one
 *  (port 18082, contextSize 3072, keepalive 20 s, warmupPrompt) in index.ts. */
export interface ReplyServerLike {
  start(): Promise<void>;
  stop(): void;
  isRunning(): boolean;
  getEndpoint(): string;
}

export interface ReplyModelManagerLike {
  isInstalled(desc: ModelDescriptor): Promise<boolean>;
  download(desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void): Promise<void>;
  getInstalledPath(desc: ModelDescriptor): string;
}

export interface ReplyServerManagerDeps {
  createServer: (modelPath: string) => ReplyServerLike;
  modelManager: ReplyModelManagerLike;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

export interface ReplyServerPrefs { enabled: boolean; replyModelId: string }

/**
 * Lifecycle of the second llama-server, tied to the preference (spec §8):
 * off → nothing runs and no RAM is used; on → download if missing, then
 * start; off again → SIGTERM. One automatic restart after a request failure,
 * then `failed` until the user re-applies. All transitions are serialized.
 */
export class ReplyServerManager {
  private state: ReplyServerState = "off";
  private server: ReplyServerLike | null = null;
  private current: ReplyServerPrefs | null = null;
  private restarts = 0;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly stateListeners: Array<(s: ReplyServerState) => void> = [];
  private readonly progressListeners: Array<(p: { bytes: number; total: number }) => void> = [];

  constructor(private readonly deps: ReplyServerManagerDeps) {}

  getState(): ReplyServerState { return this.state; }
  isReady(): boolean { return this.state === "ready" && this.server !== null && this.server.isRunning(); }
  getEndpoint(): string | null { return this.isReady() && this.server ? this.server.getEndpoint() : null; }
  lastError(): string | null { return this.error; }

  onStateChange(cb: (s: ReplyServerState) => void): () => void {
    this.stateListeners.push(cb);
    return () => { const i = this.stateListeners.indexOf(cb); if (i >= 0) this.stateListeners.splice(i, 1); };
  }
  onDownloadProgress(cb: (p: { bytes: number; total: number }) => void): () => void {
    this.progressListeners.push(cb);
    return () => { const i = this.progressListeners.indexOf(cb); if (i >= 0) this.progressListeners.splice(i, 1); };
  }

  /** Reconciles the running state with the preferences. Serialized. */
  apply(prefs: ReplyServerPrefs): Promise<void> {
    const job = this.queue.then(() => this.reconcile(prefs));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** One automatic restart per apply(); false when refused or off. */
  recover(): Promise<boolean> {
    let result = false;
    const job = this.queue.then(async () => { result = await this.doRecover(); });
    this.queue = job.catch(() => undefined);
    return job.then(() => result);
  }

  /** Synchronous stop for will-quit. */
  stop(): void {
    this.stopServer();
    this.current = null;
    this.setState("off");
  }

  private setState(next: ReplyServerState, meta: Record<string, unknown> = {}): void {
    if (next === this.state && next !== "failed") return;
    this.state = next;
    void this.deps.logger.info("reply server state", { state: next, modelId: this.current?.replyModelId ?? null, ...meta });
    for (const l of this.stateListeners) l(next);
  }

  private stopServer(): void {
    if (this.server) { this.server.stop(); this.server = null; }
  }

  private async reconcile(prefs: ReplyServerPrefs): Promise<void> {
    if (!prefs.enabled) {
      if (this.server || this.state !== "off") { this.stopServer(); this.current = null; this.setState("off"); }
      this.current = null;
      return;
    }
    const same = this.current !== null && this.current.replyModelId === prefs.replyModelId && this.state === "ready";
    if (same) return;
    this.stopServer();
    this.current = { ...prefs };
    this.restarts = 0;
    this.error = null;
    const desc = getModelById("reply", prefs.replyModelId);
    if (!desc) { this.error = `unknown reply model: ${prefs.replyModelId}`; this.setState("failed"); return; }
    try {
      if (!(await this.deps.modelManager.isInstalled(desc))) {
        this.setState("downloading");
        const t0 = Date.now();
        await this.deps.modelManager.download(desc, (p) => { for (const l of this.progressListeners) l(p); });
        void this.deps.logger.info("reply model downloaded", { modelId: desc.id, ms: Date.now() - t0 });
      }
      await this.startServer(desc);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.stopServer();
      void this.deps.logger.error("reply server failed", { modelId: desc.id, message: this.error });
      this.setState("failed");
    }
  }

  private async startServer(desc: ModelDescriptor): Promise<void> {
    this.setState("starting");
    const t0 = Date.now();
    const server = this.deps.createServer(this.deps.modelManager.getInstalledPath(desc));
    this.server = server;
    try {
      await server.start();
    } catch (err) {
      server.stop();
      this.server = null;
      throw err;
    }
    this.setState("ready", { loadMs: Date.now() - t0 });
  }

  private async doRecover(): Promise<boolean> {
    if (!this.current || this.state === "off") return false;
    if (this.restarts >= 1) {
      this.error = "reply server restarted once already";
      this.stopServer();
      this.setState("failed");
      return false;
    }
    this.restarts += 1;
    const desc = getModelById("reply", this.current.replyModelId);
    if (!desc) return false;
    this.stopServer();
    try {
      await this.startServer(desc);
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setState("failed");
      return false;
    }
  }
}
