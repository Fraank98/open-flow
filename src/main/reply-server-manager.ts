import { getModelById } from "./model-catalog.js";
import type { ModelDescriptor } from "./utils/model-paths.js";
import type { ReplyServerState } from "../shared/reply-types.js";
import type { DownloadTracker } from "./utils/download-tracker.js";
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
  download(desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void, opts?: { signal?: AbortSignal }): Promise<void>;
  getInstalledPath(desc: ModelDescriptor): string;
}

export interface ReplyServerManagerDeps {
  createServer: (modelPath: string) => ReplyServerLike;
  modelManager: ReplyModelManagerLike;
  /** Shared with the Settings window: a download started here shows up on its
   *  card, and one the card already started is joined instead of repeated. */
  downloads: DownloadTracker;
  logger: Pick<Logger, "info" | "error">;
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
  /** Bumped by stop() and by a disabling apply(); a queued job whose captured
   *  generation no longer matches abandons its effects instead of resurrecting
   *  a state that whoever bumped it already set. See `reconcile`/`startServer`. */
  private generation = 0;
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
    // A disable must invalidate in-flight work immediately, not once its turn
    // in the queue comes up: bump the generation now, before the job is even
    // queued, so a download/start already in progress notices on its next
    // await and gives up instead of finishing behind our back.
    if (!prefs.enabled) this.generation += 1;
    // Capture the generation now too — at enqueue time, not when the queue
    // later gives this job its turn. The bump above is synchronous but the
    // queue turn is not: a job enqueued *before* a stop()/disable, but whose
    // turn comes up *after* it, must still compare against the generation it
    // was enqueued under, not the one already bumped by the time it runs —
    // otherwise its own recheck below is comparing a stale baseline to
    // itself and can never see a mismatch.
    const generation = this.generation;
    const job = this.queue.then(() => this.reconcile(prefs, generation));
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** One automatic restart per apply(); false when refused or off. */
  recover(): Promise<boolean> {
    let result = false;
    // Same reasoning as apply(): capture at enqueue time, not job-start time.
    const generation = this.generation;
    const job = this.queue.then(async () => { result = await this.doRecover(generation); });
    this.queue = job.catch(() => undefined);
    return job.then(() => result);
  }

  /** Synchronous stop for will-quit. */
  stop(): void {
    this.generation += 1;
    this.stopServer();
    this.current = null;
    this.error = null;
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

  private async reconcile(prefs: ReplyServerPrefs, generation: number): Promise<void> {
    if (!prefs.enabled) {
      if (this.server || this.state !== "off") { this.stopServer(); this.setState("off"); }
      this.current = null;
      this.error = null;
      return;
    }
    // Entry check: this job may have sat in the queue behind a stop()/disable
    // whose generation bump already landed before this job's turn came up
    // (`current`/`state` might not be rewritten yet either — a disabling
    // apply()'s own reconcile could still be queued behind this one). Back
    // off without touching state — whoever bumped it already set what they
    // wanted.
    if (generation !== this.generation) return;
    const same = this.current !== null && this.current.replyModelId === prefs.replyModelId && this.isReady();
    if (same) {
      // The restart budget exists to stop an *automatic* restart loop from a
      // failed request; a re-apply — identical or not — is always a
      // deliberate user action and can never reopen that loop, so it always
      // regenerates the budget, matching the class docstring ("... until the
      // user re-applies").
      this.restarts = 0;
      return;
    }
    this.stopServer();
    this.current = { ...prefs };
    this.restarts = 0;
    this.error = null;
    const desc = getModelById("reply", prefs.replyModelId);
    if (!desc) { this.error = `unknown reply model: ${prefs.replyModelId}`; this.setState("failed"); return; }
    try {
      const installed = await this.deps.modelManager.isInstalled(desc);
      // The one await in this module that previously had no recheck: a
      // stop()/disable landing here left the state stuck on "downloading" or
      // "starting" forever, since stop()'s own setState("off") had already
      // happened (and is a no-op once the state already reads "off").
      if (generation !== this.generation) return;
      if (!installed) {
        this.setState("downloading");
        const t0 = Date.now();
        await this.deps.downloads.start(desc.id, (signal, report) =>
          this.deps.modelManager.download(desc, (p) => {
            report(p);
            // No progress for a feature the user has already turned off or
            // moved on from.
            if (generation !== this.generation) return;
            for (const l of this.progressListeners) l(p);
          }, { signal }));
        void this.deps.logger.info("reply model downloaded", { modelId: desc.id, ms: Date.now() - t0 });
        // Superseded while the download was in flight: nothing was started,
        // so there is nothing to stop. Note this does not abort the HTTP
        // request itself — modelManager.download has no cancellation
        // contract (adding one would also touch dictation model downloads).
        // What this guarantees is the memory half of the constraint: no
        // server gets started and no model gets loaded into RAM afterwards.
        if (generation !== this.generation) return;
      }
      await this.startServer(desc, generation);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      void this.deps.logger.error("reply server failed", { modelId: desc.id, message: this.error });
      this.setState("failed");
      try { this.stopServer(); } catch { /* best-effort cleanup; state already reflects the failure */ }
    }
  }

  private async startServer(desc: ModelDescriptor, generation: number): Promise<void> {
    this.setState("starting");
    const t0 = Date.now();
    const server = this.deps.createServer(this.deps.modelManager.getInstalledPath(desc));
    this.server = server;
    try {
      await server.start();
    } catch (err) {
      if (this.server === server) { this.server = null; server.stop(); }
      // Superseded while starting (e.g. stop() tore the process down mid-health-check):
      // whoever bumped the generation already set the state they want.
      if (generation !== this.generation) return;
      throw err;
    }
    if (generation !== this.generation) {
      // Superseded while starting: stop the server we just brought up,
      // unless whoever bumped the generation already stopped it themselves.
      if (this.server === server) { this.server = null; server.stop(); }
      return;
    }
    this.setState("ready", { loadMs: Date.now() - t0 });
  }

  private async doRecover(generation: number): Promise<boolean> {
    if (!this.current || this.state === "off") return false;
    // Same reasoning as reconcile's entry check: this job may have been
    // queued before a stop()/disabling apply() whose bump already landed,
    // even if `current`/`state` haven't been rewritten yet (that job might
    // still be waiting behind this one in the queue).
    if (generation !== this.generation) return false;
    if (this.restarts >= 1) {
      this.error = "reply server restarted once already";
      this.stopServer();
      this.setState("failed");
      return false;
    }
    const desc = getModelById("reply", this.current.replyModelId);
    if (!desc) return false;
    // Spends the one-restart budget up front. If stop()/disable supersedes us
    // before the restart lands (checked below), that spend is harmless: stop()
    // nulls `current` so this budget can never be consulted again, and a fresh
    // apply() unconditionally resets `restarts` to 0 in reconcile — so the
    // user's next real restart still gets a full budget either way.
    this.restarts += 1;
    this.stopServer();
    try {
      await this.startServer(desc, generation);
      // Superseded while starting: the restart did not actually happen, so
      // report failure rather than a misleading true (startServer already
      // left state/server exactly as whoever superseded us wanted).
      return generation === this.generation;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.setState("failed");
      return false;
    }
  }
}
