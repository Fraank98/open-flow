import { spawn } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for the llama.cpp bump (b4404 -> v0.4.0): since v0.4.0,
// `-fa` takes an optional [on|off|auto] value. Passed bare (as it used to
// be), the parser swallows the next argv token ("-ctk") as -fa's value and
// llama-server refuses to start. Assert the exact spawn args so this can't
// regress.

const spawnMock = vi.hoisted(() => vi.fn<typeof spawn>());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { LLMServer as LLMServerClass } from "../../src/main/llm-server.js";
import { fakeChild, type FakeChild } from "../helpers/fake-child.js";

async function fakeFetch(url: string): Promise<Response> {
  if (String(url).endsWith("/health")) {
    return new Response(null, { status: 200 });
  }
  // /completion (warmup ping) — best-effort, any 200 is fine.
  return new Response(JSON.stringify({ content: "" }), { status: 200 });
}

describe("LLMServer.start spawn args", () => {
  let server: LLMServerClass | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => fakeFetch(String(input))));
  });

  afterEach(() => {
    server?.stop();
    vi.unstubAllGlobals();
  });

  it("passes an explicit value to -fa, not a bare flag", async () => {
    spawnMock.mockReturnValue(fakeChild());

    server = new LLMServerClass({
      binaryPath: "/fake/llama-server",
      modelPath: "/fake/model.gguf",
      port: 19999,
      healthySettleMs: 0,
    });

    await server.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toBeDefined();

    const faIndex = args!.indexOf("-fa");
    expect(faIndex).toBeGreaterThanOrEqual(0);
    // The token right after -fa must be its explicit value, never another flag.
    expect(args![faIndex + 1]).toBe("on");

    // -ctk must remain a separate flag+value pair, not swallowed by -fa.
    const ctkIndex = args!.indexOf("-ctk");
    expect(ctkIndex).toBeGreaterThan(faIndex + 1);
    expect(args![ctkIndex + 1]).toBe("q8_0");
  });
});

let child: FakeChild;

describe("LLMServer.start liveness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    child = fakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
    // Something else already answers /health 200 on the port (an orphaned
    // llama-server from a previous run).
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, { status: 200 })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const make = () => new LLMServerClass({ binaryPath: "llama-server", modelPath: "m.gguf", port: 18080 });

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
