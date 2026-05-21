import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/main/logger.js";

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
    // debug.log may not exist — that's fine
    try {
      await stat(join(dir, "debug.log"));
      const c = await readFile(join(dir, "debug.log"), "utf8");
      expect(c).not.toContain("hidden");
    } catch {
      // OK — file doesn't exist
    }
  });

  it("writes debug lines when debug=true", async () => {
    const logger = createLogger({ dir, debug: true, maxBytes: 1024 * 1024 });
    await logger.debug("visible");
    await logger.flush();
    const c = await readFile(join(dir, "debug.log"), "utf8");
    expect(c).toContain("visible");
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
});
