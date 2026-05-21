import { EventEmitter } from "node:events";
import { ChildProcess, spawn } from "node:child_process";

export interface PTTManagerOptions {
  /** Path to the compiled flag-monitor Swift binary. */
  binaryPath: string;
  /** Minimum hold duration to count as PTT vs accidental tap (ms). */
  minHoldMs?: number;
}

/**
 * Push-to-talk manager using a tiny Swift helper that wraps
 * NSEvent.addGlobalMonitorForEvents(.flagsChanged). The helper requires only
 * macOS Accessibility permission (not Input Monitoring) — same model as
 * Wispr Flow and similar dictation apps.
 *
 * The helper writes "DOWN\n" / "UP\n" to stdout when the Option modifier key
 * is held / released globally. This class spawns it, parses the stream, and
 * emits 'start', 'stop', and 'cancel' events with a debounce against
 * accidental taps.
 */
export class PTTManager extends EventEmitter {
  private readonly binaryPath: string;
  private readonly minHoldMs: number;
  private child: ChildProcess | null = null;
  private heldSince: number | null = null;
  private startEmitted = false;
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(opts: PTTManagerOptions) {
    super();
    this.binaryPath = opts.binaryPath;
    this.minHoldMs = opts.minHoldMs ?? 150;
  }

  start(): void {
    if (this.child) return;

    const child = spawn(this.binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let nl = stdoutBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        this.handleLine(line);
        nl = stdoutBuffer.indexOf("\n");
      }
    });

    let stderr = "";
    let stderrBuffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stderr += s;
      stderrBuffer += s;
      // Emit each complete line as a diagnostic event so the host can log it
      let nl = stderrBuffer.indexOf("\n");
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl).trim();
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line) this.emit("diagnostic", line);
        nl = stderrBuffer.indexOf("\n");
      }
    });

    child.on("error", (err) => {
      this.emit("error", new Error(`flag-monitor spawn failed: ${err.message}`));
      this.child = null;
    });

    child.on("close", (code, signal) => {
      const wasIntentional = this.child === null;
      this.child = null;
      this.clearHoldTimer();
      this.heldSince = null;
      this.startEmitted = false;
      if (!wasIntentional && code !== 0) {
        this.emit(
          "error",
          new Error(
            `flag-monitor exited unexpectedly (code=${code}, signal=${signal}). stderr: ${stderr.trim().slice(0, 500)}`,
          ),
        );
      }
    });
  }

  stop(): void {
    if (!this.child) return;
    const c = this.child;
    this.child = null;
    this.clearHoldTimer();
    this.heldSince = null;
    this.startEmitted = false;
    c.kill("SIGTERM");
  }

  private handleLine(line: string): void {
    if (line === "READY") {
      this.emit("ready");
      return;
    }
    if (line === "ERROR_NO_TRUST") {
      this.emit("trustRequired");
      return;
    }
    if (line === "DOWN") {
      if (this.heldSince !== null) return; // already holding
      this.heldSince = Date.now();
      this.startEmitted = false;
      this.holdTimer = setTimeout(() => {
        this.startEmitted = true;
        this.emit("start");
      }, this.minHoldMs);
    } else if (line === "UP") {
      if (this.heldSince === null) return;
      this.heldSince = null;
      this.clearHoldTimer();
      if (this.startEmitted) {
        this.emit("stop");
        this.startEmitted = false;
      } else {
        this.emit("cancel");
      }
    }
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}
