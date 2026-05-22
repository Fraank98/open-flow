import { ChildProcess, spawn } from "node:child_process";

export interface LLMServerOptions {
  binaryPath: string;
  modelPath: string;
  port?: number;
  ngl?: number;
  contextSize?: number;
  /** Max time to wait for /health to return 200 (ms). */
  startupTimeoutMs?: number;
}

/**
 * Long-lived `llama-server` process. The model is loaded once into RAM and
 * stays warm for the app's lifetime, so per-request latency drops from
 * "cold start of ~1 GB model = 2-5s" to "single inference = ~100-500ms".
 *
 * Lifecycle:
 *   const server = new LLMServer({ binaryPath, modelPath });
 *   await server.start();
 *   const url = server.getEndpoint(); // http://127.0.0.1:<port>
 *   ...
 *   server.stop();
 */
export class LLMServer {
  private child: ChildProcess | null = null;
  private readonly port: number;
  private readonly opts: LLMServerOptions;
  private stderrBuffer = "";

  constructor(opts: LLMServerOptions) {
    this.opts = opts;
    this.port = opts.port ?? 18080;
  }

  getEndpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const args = [
      "-m", this.opts.modelPath,
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-ngl", String(this.opts.ngl ?? 99),
      "-c", String(this.opts.contextSize ?? 2048),
      "--log-disable",
    ];

    const startSpawn = Date.now();

    this.child = spawn(this.opts.binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      // Bounded: keep only the last ~4 KB so a long-running server doesn't
      // grow unbounded in RAM. Stderr is only inspected on startup failure.
      this.stderrBuffer += chunk.toString("utf8");
      if (this.stderrBuffer.length > 4096) {
        this.stderrBuffer = this.stderrBuffer.slice(-4096);
      }
    });

    const child = this.child;
    const exitState: {
      exited: boolean;
      info: { code: number | null; signal: NodeJS.Signals | null } | null;
    } = { exited: false, info: null };
    child.on("exit", (code, signal) => {
      exitState.exited = true;
      exitState.info = { code, signal };
    });

    try {
      await this.waitForHealthy(this.opts.startupTimeoutMs ?? 30_000, () => exitState.exited);
      // Warm up the Metal pipeline with a 1-token completion so the user's
      // first real dictation benefits from a JIT-compiled Metal kernel cache.
      // Without this, the first /completion call after model load is ~2x
      // slower than steady-state.
      await this.warmup().catch(() => undefined);
      void startSpawn;
    } catch (err) {
      this.stop();
      const detail = exitState.info
        ? ` (process exited code=${exitState.info.code} signal=${exitState.info.signal})`
        : "";
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}${detail}. ` +
          `Last stderr: ${this.stderrBuffer.trim().slice(-500)}`,
      );
    }
  }

  private async warmup(): Promise<void> {
    try {
      await fetch(`${this.getEndpoint()}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "hi",
          n_predict: 1,
          temperature: 0,
          cache_prompt: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Warmup is best-effort. If it fails, the real first request will still
      // work, just slightly slower.
    }
  }

  stop(): void {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    try {
      c.kill("SIGTERM");
    } catch {
      // ignore
    }
  }

  private async waitForHealthy(timeoutMs: number, hasExited: () => boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `${this.getEndpoint()}/health`;
    while (Date.now() < deadline) {
      if (hasExited()) {
        throw new Error("llama-server exited before becoming healthy");
      }
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(1_000),
        });
        if (res.ok) return;
        // llama-server returns 503 while loading model. Keep polling.
      } catch {
        // ECONNREFUSED while server is starting up. Keep polling.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`llama-server did not become healthy within ${timeoutMs}ms`);
  }
}
