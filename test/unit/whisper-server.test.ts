import { spawn } from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn<typeof spawn>());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { WhisperServer } from "../../src/main/whisper-server.js";
import { fakeChild, type FakeChild } from "../helpers/fake-child.js";

describe("WhisperServer", () => {
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

  const make = (extra: Partial<ConstructorParameters<typeof WhisperServer>[0]> = {}) =>
    new WhisperServer({ binaryPath: "/bin/whisper-server", modelPath: "/m/ggml.bin", ...extra });

  it("spawns with the full argument list, polling GET / on the default port", async () => {
    const server = make();
    await server.start();
    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/whisper-server",
      ["-m", "/m/ggml.bin", "--host", "127.0.0.1", "--port", "18081", "-t", "4", "-nf"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:18081/");
    expect(server.getEndpoint()).toBe("http://127.0.0.1:18081");
    expect(server.isRunning()).toBe(true);
    server.stop();
  });

  it("honours custom port and thread count", async () => {
    const server = make({ port: 19002, threads: 8 });
    await server.start();
    const args = spawnMock.mock.calls[0]![1]!;
    expect(args[args.indexOf("--port") + 1]).toBe("19002");
    expect(args[args.indexOf("-t") + 1]).toBe("8");
    expect(server.getEndpoint()).toBe("http://127.0.0.1:19002");
    server.stop();
  });

  it("a second start() while running is a no-op", async () => {
    const server = make();
    await server.start();
    await server.start();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    server.stop();
  });

  it("polls every 250 ms through non-ok responses and fetch errors until GET / is 200", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () => {
      n++;
      if (n === 1) return new Response(null, { status: 503 });
      if (n === 2) throw new Error("ECONNREFUSED");
      return new Response(null, { status: 200 });
    });
    const server = make();
    let resolved = false;
    const started = server.start().then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(n).toBe(2);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await started;
    expect(n).toBe(3);
    server.stop();
  });

  it("fails fast when the child exits before becoming healthy, with code/signal and stderr", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 10_000 });
    const assertion = expect(server.start()).rejects.toThrow(
      /whisper-server exited before becoming healthy \(process exited code=2 signal=null\)\. Last stderr: bad model$/,
    );
    c.stderr.emit("data", Buffer.from("  bad model\n"));
    await vi.advanceTimersByTimeAsync(10);
    c.emit("exit", 2, null);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(server.isRunning()).toBe(false);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("times out with the stderr tail (last 500 chars) in the message and kills the child", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 503 }));
    const server = make({ startupTimeoutMs: 1_000 });
    let message = "";
    const done = server.start().catch((e: Error) => { message = e.message; });
    c.stderr.emit("data", Buffer.from("HEAD" + "z".repeat(9_000) + "TAILMARK"));
    await vi.advanceTimersByTimeAsync(1_500);
    await done;
    expect(message).toContain("whisper-server did not become healthy within 1000ms");
    const tail = message.split("Last stderr: ")[1]!;
    expect(tail.length).toBe(500);
    expect(tail.endsWith("TAILMARK")).toBe(true);
    expect(server).toHaveProperty("stderrBuffer", "z".repeat(4088) + "TAILMARK");
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stop() sends SIGTERM once and is idempotent", async () => {
    const server = make();
    await server.start();
    server.stop();
    server.stop();
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
    expect(server.isRunning()).toBe(false);
  });

  it("stop() before start() does nothing and a throwing kill is swallowed", async () => {
    make().stop();
    expect(c.kill).not.toHaveBeenCalled();
    c.kill.mockImplementation(() => { throw new Error("ESRCH"); });
    const server = make();
    await server.start();
    expect(() => server.stop()).not.toThrow();
    expect(server.isRunning()).toBe(false);
  });
});
