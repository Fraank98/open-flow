import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/main/logger.js";

/** File contents, or "" when the file does not exist. Never swallows assertions. */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

describe("Logger", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "of-log-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes error lines to error.log", async () => {
    const logger = createLogger({ dir, debug: false, maxBytes: 1024 * 1024 });
    await logger.error("boom", { code: "E1" });
    await logger.flush();
    const content = await readFile(join(dir, "error.log"), "utf8");
    expect(content).toMatch(/ERROR/);
    expect(content).toContain("boom");
    expect(content).toContain('"code":"E1"');
  });

  it("skips debug lines when debug=false", async () => {
    const logger = createLogger({ dir, debug: false, maxBytes: 1024 * 1024 });
    await logger.debug("hidden");
    await logger.flush();
    // debug.log may not exist at all; either way "hidden" must not be in it.
    expect(await readOrEmpty(join(dir, "debug.log"))).not.toContain("hidden");
  });

  it("writes debug lines when debug=true", async () => {
    const logger = createLogger({ dir, debug: true, maxBytes: 1024 * 1024 });
    await logger.debug("visible");
    await logger.flush();
    const c = await readFile(join(dir, "debug.log"), "utf8");
    expect(c).toContain("visible");
  });

  it("setDebug(true) starts writing debug lines, setDebug(false) stops", async () => {
    const logger = createLogger({ dir, debug: false, maxBytes: 1024 * 1024 });
    await logger.debug("before-enable");
    logger.setDebug(true);
    await logger.debug("while-enabled");
    logger.setDebug(false);
    await logger.debug("after-disable");
    const c = await readFile(join(dir, "debug.log"), "utf8");
    expect(c).toContain("while-enabled");
    expect(c).not.toContain("before-enable");
    expect(c).not.toContain("after-disable");
  });

  it("rotates error.log when it exceeds maxBytes", async () => {
    const logger = createLogger({ dir, debug: false, maxBytes: 200 });
    for (let i = 0; i < 50; i++) {
      await logger.error("x".repeat(20));
    }
    await logger.flush();
    const main = await stat(join(dir, "error.log"));
    const rotated = await stat(join(dir, "error.log.1"));
    expect(main.size).toBeLessThanOrEqual(200 + 200); // some slack
    expect(rotated.size).toBeGreaterThan(0);
  });

  it("serializes concurrent writes without losing entries", async () => {
    // Use a maxBytes large enough that 20 small messages fit without rotation,
    // but still exercise the per-file write queue under concurrent dispatch.
    const logger = createLogger({ dir, debug: false, maxBytes: 100, maxRotations: 10 });
    // Fire 20 concurrent writes; with serialization all entries must be preserved.
    const writes = Array.from({ length: 20 }, (_, i) =>
      logger.error(`msg-${i.toString().padStart(2, "0")}`),
    );
    await Promise.all(writes);
    // Read all log files (current + rotated) and count total lines.
    let total = 0;
    for (let i = 0; i <= 10; i++) {
      const name = i === 0 ? "error.log" : `error.log.${i}`;
      try {
        const c = await readFile(join(dir, name), "utf8");
        total += c.split("\n").filter((l) => l.length > 0).length;
      } catch {
        // file doesn't exist
      }
    }
    // With proper serialization, we expect ALL 20 to be preserved across rotated files
    expect(total).toBeGreaterThanOrEqual(20);
  });

  it("does not throw on cyclic meta", async () => {
    const logger = createLogger({ dir, debug: false, maxBytes: 1024 * 1024 });
    const cyclic: Record<string, unknown> = { name: "boom" };
    cyclic.self = cyclic; // create cycle
    await expect(logger.error("error with cycle", cyclic)).resolves.toBeUndefined();
    const content = await readFile(join(dir, "error.log"), "utf8");
    expect(content).toContain("error with cycle");
    expect(content).toContain("unserializable");
  });
});
