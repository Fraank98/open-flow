import { ChildProcess, spawn } from "node:child_process";

export interface WhisperServerOptions {
  binaryPath: string;
  modelPath: string;
  port?: number;
  threads?: number;
  startupTimeoutMs?: number;
}

/**
 * Long-lived `whisper-server` process. The Whisper model is loaded once
 * into RAM and stays warm, so per-transcription latency drops from
 * "spawn whisper-cli + load model = ~1.4-2.5s for a 5s clip" to
 * "single inference = ~400-800ms".
 */
export class WhisperServer {
  private child: ChildProcess | null = null;
  private readonly port: number;
  private readonly opts: WhisperServerOptions;
  private stderrBuffer = "";

  constructor(opts: WhisperServerOptions) {
    this.opts = opts;
    this.port = opts.port ?? 18081;
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
      "-t", String(this.opts.threads ?? 4),
    ];

    this.child = spawn(this.opts.binaryPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
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
    // whisper-server doesn't have /health; GET / returns 200 once the HTTP
    // listener is up. The model still needs a moment to fully load after
    // that, but inference requests will block until it's ready.
    const deadline = Date.now() + timeoutMs;
    const url = `${this.getEndpoint()}/`;
    while (Date.now() < deadline) {
      if (hasExited()) {
        throw new Error("whisper-server exited before becoming healthy");
      }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return;
      } catch {
        // server still binding — keep polling
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`whisper-server did not become healthy within ${timeoutMs}ms`);
  }
}
