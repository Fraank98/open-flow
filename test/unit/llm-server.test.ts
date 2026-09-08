import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for the llama.cpp bump (b4404 -> v0.4.0): since v0.4.0,
// `-fa` takes an optional [on|off|auto] value. Passed bare (as it used to
// be), the parser swallows the next argv token ("-ctk") as -fa's value and
// llama-server refuses to start. Assert the exact spawn args so this can't
// regress.

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

/** Minimal fake ChildProcess: stderr stream + exit emitter, no-op kill. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
  };
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

async function fakeFetch(url: string): Promise<Response> {
  if (String(url).endsWith("/health")) {
    return new Response(null, { status: 200 });
  }
  // /completion (warmup ping) — best-effort, any 200 is fine.
  return new Response(JSON.stringify({ content: "" }), { status: 200 });
}

describe("LLMServer.start spawn args", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(fakeFetch) as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes an explicit value to -fa, not a bare flag", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());

    const { LLMServer } = await import("../../src/main/llm-server.js");
    const server = new LLMServer({
      binaryPath: "/fake/llama-server",
      modelPath: "/fake/model.gguf",
      port: 19999,
    });

    await server.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    const faIndex = args.indexOf("-fa");
    expect(faIndex).toBeGreaterThanOrEqual(0);
    // The token right after -fa must be its explicit value, never another flag.
    expect(args[faIndex + 1]).toBe("on");

    // -ctk must remain a separate flag+value pair, not swallowed by -fa.
    const ctkIndex = args.indexOf("-ctk");
    expect(ctkIndex).toBeGreaterThan(faIndex + 1);
    expect(args[ctkIndex + 1]).toBe("q8_0");

    server.stop();
  });
});
