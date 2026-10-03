import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// A fake child process: the server only needs stderr, kill() and the "exit" event.
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}
let child: FakeChild;

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => child),
}));

import { LLMServer } from "../../src/main/llm-server.js";

describe("LLMServer.start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    child = new FakeChild();
    // Something else already answers /health 200 on the port (an orphaned
    // llama-server from a previous run).
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const make = () => new LLMServer({ binaryPath: "llama-server", modelPath: "m.gguf", port: 18080 });

  it("fails when its own child exits, even though /health answers 200 (orphan on the port)", async () => {
    const server = make();
    const started = server.start();
    const assertion = expect(started).rejects.toThrow(/exited/);
    // The child can't bind the port and dies right after the orphan answered.
    await vi.advanceTimersByTimeAsync(50);
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(server.isRunning()).toBe(false);
  });

  it("resolves when its child stays alive and /health answers 200", async () => {
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(started).resolves.toBeUndefined();
    expect(server.isRunning()).toBe(true);
  });
});
