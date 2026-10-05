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

describe("LLMServer lifecycle", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let c: FakeChild;

  beforeEach(() => {
    vi.useFakeTimers();
    c = fakeChild();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(c);
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const make = (extra: Partial<ConstructorParameters<typeof LLMServerClass>[0]> = {}) =>
    new LLMServerClass({ binaryPath: "/bin/llama-server", modelPath: "/m/model.gguf", port: 18080, healthySettleMs: 0, ...extra });

  const completionCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/completion"));

  it("spawns with the full argument list and stderr-only piping", async () => {
    const server = make({ port: 19001, ngl: 10, contextSize: 2048 });
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/llama-server",
      [
        "-m", "/m/model.gguf",
        "--host", "127.0.0.1",
        "--port", "19001",
        "-ngl", "10",
        "-c", "2048",
        "-fa", "on",
        "-ctk", "q8_0",
        "-ctv", "q8_0",
        "--log-disable",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    server.stop();
  });

  it("uses the defaults for port, -ngl and context size", async () => {
    const server = make({ port: undefined });
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf("--port") + 1]).toBe("18080");
    expect(args[args.indexOf("-ngl") + 1]).toBe("99");
    expect(args[args.indexOf("-c") + 1]).toBe("1536");
    expect(server.getEndpoint()).toBe("http://127.0.0.1:18080");
    server.stop();
  });

  it("a second start() while running is a no-op", async () => {
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    await server.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    server.stop();
  });

  it("stop() sends SIGTERM once and is idempotent", async () => {
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    server.stop();
    server.stop();
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    expect(server.isRunning()).toBe(false);
  });

  it("stop() before start() does nothing", () => {
    make().stop();
    expect(c.kill).not.toHaveBeenCalled();
  });

  it("stop() swallows a throwing kill and still forgets the child", async () => {
    c.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    expect(() => server.stop()).not.toThrow();
    expect(server.isRunning()).toBe(false);
  });

  it("keepalive pings the model periodically and stop() ends the loop", async () => {
    const server = make({ keepaliveMs: 10 });
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const afterStart = completionCalls().length; // warmup (+ possibly a first tick)
    await vi.advanceTimersByTimeAsync(35);
    expect(completionCalls().length).toBe(afterStart + 3);
    server.stop();
    const atStop = completionCalls().length;
    await vi.advanceTimersByTimeAsync(100);
    expect(completionCalls().length).toBe(atStop);
  });

  it("no keepalive timer when keepaliveMs is not set", async () => {
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const n = completionCalls().length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(completionCalls().length).toBe(n);
    server.stop();
  });

  it("warmup sends the warmup prompt with cache_prompt, and errors are swallowed", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/health")) return new Response(null, { status: 200 });
      throw new Error("boom");
    });
    const server = make({ warmupPrompt: "SYSTEM PROMPT" });
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await expect(started).resolves.toBeUndefined();
    const call = completionCalls()[0]!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      prompt: "SYSTEM PROMPT", n_predict: 32, temperature: 0, cache_prompt: true,
    });
    server.stop();
  });

  it("warmup without a prompt pings 'hi' with the cache disabled", async () => {
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    expect(JSON.parse(String(completionCalls()[0]![1]?.body))).toMatchObject({ prompt: "hi", cache_prompt: false });
    server.stop();
  });

  it("keeps polling through 503 and fetch errors until /health is 200", async () => {
    let n = 0;
    fetchMock.mockImplementation(async (input) => {
      if (!String(input).endsWith("/health")) return new Response(null, { status: 200 });
      n++;
      if (n === 1) return new Response(null, { status: 503 });
      if (n === 2) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 200 });
    });
    const server = make();
    const started = server.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(started).resolves.toBeUndefined();
    expect(n).toBe(3);
    server.stop();
  });

  it("times out with the exit detail and the stderr tail in the message", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 1_000 });
    const started = server.start();
    const assertion = expect(started).rejects.toThrow(
      /did not become healthy within 1000ms\. Last stderr: .*unable to bind$/s,
    );
    c.stderr.emit("data", Buffer.from("loading...\nunable to bind"));
    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    expect(server.isRunning()).toBe(false);
  });

  it("includes the process exit code and signal when the child died", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 5_000 });
    const started = server.start();
    const assertion = expect(started).rejects.toThrow(/exited before becoming healthy \(process exited code=3 signal=null\)/);
    await vi.advanceTimersByTimeAsync(10);
    c.emit("exit", 3, null);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("reports only the last 500 chars of stderr and keeps at most 4096 bytes buffered", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 500 });
    const started = server.start();
    let message = "";
    const done = started.catch((e: Error) => { message = e.message; });
    // 10000 'a' then a marker: the buffer drops everything but the tail.
    c.stderr.emit("data", Buffer.from("HEAD" + "a".repeat(10_000)));
    c.stderr.emit("data", Buffer.from("TAILMARK"));
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    const stderrPart = message.split("Last stderr: ")[1]!;
    expect(stderrPart.length).toBe(500);
    expect(stderrPart.endsWith("TAILMARK")).toBe(true);
    expect(message).not.toContain("HEAD");
  });

  it("bounds the stderr buffer at 4096 bytes", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 500 });
    const started = server.start();
    const done = started.catch(() => undefined);
    c.stderr.emit("data", Buffer.from("x".repeat(5_000)));
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect((server as unknown as { stderrBuffer: string }).stderrBuffer.length).toBe(4096);
  });
});
