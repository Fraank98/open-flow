import { mkdir, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface LoggerOptions {
  dir: string;
  debug: boolean;
  maxBytes: number;
  maxRotations?: number;
}

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): Promise<void>;
  warn(msg: string, meta?: Record<string, unknown>): Promise<void>;
  info(msg: string, meta?: Record<string, unknown>): Promise<void>;
  debug(msg: string, meta?: Record<string, unknown>): Promise<void>;
  /** Turn debug.log writing on or off at runtime (no restart needed). */
  setDebug(enabled: boolean): void;
  flush(): Promise<void>;
}

export function createLogger(opts: LoggerOptions): Logger {
  const maxRotations = opts.maxRotations ?? 3;
  const errorFile = join(opts.dir, "error.log");
  const debugFile = join(opts.dir, "debug.log");
  let initialized = false;
  let debugEnabled = opts.debug;

  async function init(): Promise<void> {
    if (initialized) return;
    await mkdir(opts.dir, { recursive: true });
    initialized = true;
  }

  async function rotateIfNeeded(file: string): Promise<void> {
    try {
      const s = await stat(file);
      if (s.size < opts.maxBytes) return;
    } catch {
      return; // file doesn't exist yet
    }
    // Shift .N → .N+1, dropping the oldest
    for (let i = maxRotations - 1; i >= 1; i--) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      try {
        await rename(src, dst);
      } catch {
        // src might not exist
      }
    }
    // Drop the .maxRotations+1 if present
    try {
      await unlink(`${file}.${maxRotations + 1}`);
    } catch {
      // ignore
    }
    await rename(file, `${file}.1`);
  }

  const queues = new Map<string, Promise<unknown>>();

  async function writeLine(file: string, line: string): Promise<void> {
    const previous = queues.get(file) ?? Promise.resolve();
    const job = previous
      .catch(() => undefined) // don't let prior errors poison the chain
      .then(async () => {
        await init();
        await rotateIfNeeded(file);
        try {
          await appendFile(file, line + "\n", "utf8");
        } catch {
          await writeFile(file, line + "\n", "utf8");
        }
      });
    queues.set(file, job);
    await job;
  }

  function format(level: string, msg: string, meta?: Record<string, unknown>): string {
    const ts = new Date().toISOString();
    let metaStr = "";
    if (meta) {
      try {
        metaStr = " " + JSON.stringify(meta);
      } catch {
        metaStr = " [unserializable meta]";
      }
    }
    return `${ts} ${level} ${msg}${metaStr}`;
  }

  return {
    async error(msg, meta) {
      await writeLine(errorFile, format("ERROR", msg, meta));
    },
    async warn(msg, meta) {
      await writeLine(errorFile, format("WARN", msg, meta));
    },
    async info(msg, meta) {
      await writeLine(errorFile, format("INFO", msg, meta));
    },
    async debug(msg, meta) {
      if (!debugEnabled) return;
      await writeLine(debugFile, format("DEBUG", msg, meta));
    },
    setDebug(enabled) {
      debugEnabled = enabled;
    },
    async flush() {
      // appendFile already flushes per call
    },
  };
}
