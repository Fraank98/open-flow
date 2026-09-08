import { describe, it, expect, vi } from "vitest";
import { ReplyServerManager, type ReplyServerLike } from "../../src/main/reply-server-manager.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

/** A promise the test releases on its own schedule, to put a job mid-`await`. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeServer(opts: { failStart?: boolean; startGate?: Promise<void> } = {}) {
  let running = false;
  let stopped = false; // stop() was called while start() was still pending on startGate
  const s: ReplyServerLike & { startCalls: number; stopCalls: number } = {
    startCalls: 0, stopCalls: 0,
    async start() {
      s.startCalls += 1;
      if (opts.startGate) await opts.startGate;
      if (opts.failStart) throw new Error("llama-server did not become healthy within 90000ms");
      // A stop() that fired while we were suspended above already tore the
      // process down; resolving "successfully" afterward must not resurrect it.
      if (!stopped) running = true;
    },
    stop() { s.stopCalls += 1; running = false; stopped = true; },
    isRunning: () => running,
    getEndpoint: () => "http://127.0.0.1:18082",
  };
  return s;
}

function env(over: {
  installed?: string[];
  failStart?: boolean;
  failDownload?: boolean;
  /** Hold `download()` open until the test calls `releaseDownload()`. */
  deferDownload?: boolean;
  /** Hold every created server's `start()` open until the test releases it via `releaseStart(index)`. */
  deferStart?: boolean;
} = {}) {
  const installed = new Set(over.installed ?? ["gemma-3-4b-it-Q4_K_M.gguf"]);
  const servers: Array<ReturnType<typeof fakeServer> & { modelPath: string }> = [];
  const downloadGate = over.deferDownload ? deferred<void>() : null;
  const download = vi.fn(async (desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void) => {
    if (over.failDownload) throw new Error("sha256 mismatch");
    if (downloadGate) await downloadGate.promise;
    onProgress?.({ bytes: 1, total: 2 });
    installed.add(desc.filename);
  });
  const startGates: Array<ReturnType<typeof deferred<void>>> = [];
  const logger = { info: vi.fn(async () => {}), error: vi.fn(async () => {}) };
  const states: string[] = [];
  const m = new ReplyServerManager({
    createServer: (modelPath) => {
      const gate = over.deferStart ? deferred<void>() : null;
      if (gate) startGates.push(gate);
      const s = Object.assign(fakeServer({ failStart: over.failStart, startGate: gate?.promise }), { modelPath });
      servers.push(s);
      return s;
    },
    modelManager: {
      isInstalled: async (d) => installed.has(d.filename),
      download,
      getInstalledPath: (d) => `/models/${d.filename}`,
    },
    logger,
  });
  m.onStateChange((s) => states.push(s));
  return {
    m, servers, download, logger, states,
    releaseDownload: () => downloadGate?.resolve(),
    releaseStart: (i = 0) => startGates[i]?.resolve(),
  };
}

describe("ReplyServerManager.apply", () => {
  it("starts off and stays off when the feature is disabled: no server is created", async () => {
    const { m, servers, states } = env();
    expect(m.getState()).toBe("off");
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    expect(servers).toHaveLength(0);
    expect(states).toEqual([]);
    expect(m.getEndpoint()).toBeNull();
  });

  it("enabled + model installed: starting → ready with the model path of the chosen tier", async () => {
    const { m, servers, states } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(states).toEqual(["starting", "ready"]);
    expect(servers).toHaveLength(1);
    expect(servers[0]!.modelPath).toBe("/models/gemma-3-4b-it-Q4_K_M.gguf");
    expect(m.isReady()).toBe(true);
    expect(m.getEndpoint()).toBe("http://127.0.0.1:18082");
  });

  it("enabled + model missing: downloading → starting → ready, download called once with progress", async () => {
    const { m, download, states } = env({ installed: [] });
    const progress: Array<{ bytes: number; total: number }> = [];
    m.onDownloadProgress((p) => progress.push(p));
    await m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    expect(states).toEqual(["downloading", "starting", "ready"]);
    expect(download).toHaveBeenCalledTimes(1);
    expect((download.mock.calls[0]![0] as ModelDescriptor).id).toBe("gemma-4-e4b");
    expect(progress).toEqual([{ bytes: 1, total: 2 }]);
  });

  it("download failure → failed with lastError, no server created", async () => {
    const { m, servers, states } = env({ installed: [], failDownload: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(states).toEqual(["downloading", "failed"]);
    expect(servers).toHaveLength(0);
    expect(m.lastError()).toBe("sha256 mismatch");
  });

  it("start failure → failed; the failed server was stopped", async () => {
    const { m, servers } = env({ failStart: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(m.getState()).toBe("failed");
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.lastError()).toContain("did not become healthy");
  });

  it("disabling stops the server and goes back to off", async () => {
    const { m, servers, states } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    expect(servers[0]!.stopCalls).toBe(1);
    expect(states).toEqual(["starting", "ready", "off"]);
    expect(m.getEndpoint()).toBeNull();
  });

  it("changing the model stops the old server and starts a new one on the new path", async () => {
    const { m, servers } = env({ installed: ["gemma-3-4b-it-Q4_K_M.gguf", "gemma-4-E4B-it-Q4_K_M.gguf"] });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    expect(servers).toHaveLength(2);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(servers[1]!.modelPath).toBe("/models/gemma-4-E4B-it-Q4_K_M.gguf");
    expect(m.getState()).toBe("ready");
  });

  it("re-applying identical preferences while ready does nothing", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(servers).toHaveLength(1);
    expect(servers[0]!.startCalls).toBe(1);
  });

  it("an unknown model id → failed with lastError 'unknown reply model: <id>'", async () => {
    const { m } = env();
    await m.apply({ enabled: true, replyModelId: "qwen-3b" });
    expect(m.getState()).toBe("failed");
    expect(m.lastError()).toBe("unknown reply model: qwen-3b");
  });

  it("serializes concurrent apply() calls: the last one wins, no interleaving", async () => {
    const { m, servers } = env({ installed: ["gemma-3-4b-it-Q4_K_M.gguf", "gemma-4-E4B-it-Q4_K_M.gguf"] });
    await Promise.all([
      m.apply({ enabled: true, replyModelId: "gemma-3-4b" }),
      m.apply({ enabled: true, replyModelId: "gemma-4-e4b" }),
    ]);
    expect(servers.map((s) => s.modelPath)).toEqual(["/models/gemma-3-4b-it-Q4_K_M.gguf", "/models/gemma-4-E4B-it-Q4_K_M.gguf"]);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("ready");
  });
});

describe("ReplyServerManager.recover (one automatic restart)", () => {
  it("restarts once after a request failure, then refuses and goes failed on the second", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(await m.recover()).toBe(true);
    expect(servers).toHaveLength(2);
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("ready");
    expect(await m.recover()).toBe(false);
    expect(servers).toHaveLength(2);
    expect(m.getState()).toBe("failed");
    expect(m.lastError()).toBe("reply server restarted once already");
  });
  it("a fresh apply() resets the restart budget", async () => {
    const { m } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await m.recover();
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(await m.recover()).toBe(true);
  });
  it("does nothing when off", async () => {
    const { m } = env();
    expect(await m.recover()).toBe(false);
    expect(m.getState()).toBe("off");
  });

  it("stop() during an in-flight recover() discards the restart: ends off, no server left running, recover() reports it did not happen, and the budget is intact for the next apply()", async () => {
    const { m, servers, states, releaseStart } = env({ deferStart: true });
    const firstApply = m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await vi.waitFor(() => expect(states).toContain("starting"));
    releaseStart(0); // the initial start is not under test; let it complete normally
    await firstApply;
    expect(m.getState()).toBe("ready");

    const recoverPromise = m.recover();
    await vi.waitFor(() => expect(servers).toHaveLength(2)); // the restart's replacement server exists and is mid-start
    m.stop();
    releaseStart(1); // release the restart's start() only after stop() has already run
    const recovered = await recoverPromise;

    expect(recovered).toBe(false); // the restart was discarded, not completed
    expect(m.getState()).toBe("off");
    expect(m.isReady()).toBe(false);
    expect(m.getEndpoint()).toBeNull();
    expect(servers).toHaveLength(2); // no third server was leaked
    expect(servers.every((s) => !s.isRunning())).toBe(true);

    // The interrupted restart must not have spent the one-restart-per-apply()
    // budget: a fresh apply() gets a full budget again, exactly as if the
    // stop() had happened before recover() was ever called. (This apply()
    // and this recover() also create deferred-start servers, so release
    // each in turn.)
    const secondApply = m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await vi.waitFor(() => expect(servers).toHaveLength(3));
    releaseStart(2);
    await secondApply;
    const secondRecover = m.recover();
    await vi.waitFor(() => expect(servers).toHaveLength(4));
    releaseStart(3);
    expect(await secondRecover).toBe(true);
  });
});

describe("ReplyServerManager.stop", () => {
  it("stops a running server and reports off (used on will-quit)", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    m.stop();
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("off");
  });

  it("stop() during a download discards the in-flight job: no server survives, state stays off", async () => {
    const { m, servers, states, releaseDownload } = env({ installed: [], deferDownload: true });
    const applyPromise = m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    await vi.waitFor(() => expect(states).toContain("downloading"));
    m.stop();
    releaseDownload();
    await applyPromise;
    expect(servers).toHaveLength(0);
    expect(m.getState()).toBe("off");
    expect(m.getEndpoint()).toBeNull();
  });

  it("stop() during server start discards the in-flight job: state stays off, the started server is stopped", async () => {
    const { m, servers, states, releaseStart } = env({ deferStart: true });
    const applyPromise = m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await vi.waitFor(() => expect(states).toContain("starting"));
    m.stop();
    releaseStart(0);
    await applyPromise;
    expect(m.getState()).toBe("off");
    expect(m.isReady()).toBe(false);
    expect(m.getEndpoint()).toBeNull();
    expect(servers[0]!.stopCalls).toBe(1);
  });

  it("apply({enabled:false}) during a download cancels it: no server is ever created, ends off", async () => {
    const { m, servers, states, releaseDownload } = env({ installed: [], deferDownload: true });
    const enablePromise = m.apply({ enabled: true, replyModelId: "gemma-4-e4b" });
    await vi.waitFor(() => expect(states).toContain("downloading"));
    const disablePromise = m.apply({ enabled: false, replyModelId: "gemma-4-e4b" });
    releaseDownload();
    await Promise.all([enablePromise, disablePromise]);
    expect(servers).toHaveLength(0);
    expect(m.getState()).toBe("off");
  });

  it("disabling after a failure clears lastError, not just the state", async () => {
    const { m } = env({ failStart: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(m.getState()).toBe("failed");
    expect(m.lastError()).not.toBeNull();
    await m.apply({ enabled: false, replyModelId: "gemma-3-4b" });
    expect(m.getState()).toBe("off");
    expect(m.lastError()).toBeNull();
  });

  it("stop() after a failure clears lastError, not just the state", async () => {
    const { m } = env({ failStart: true });
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(m.lastError()).not.toBeNull();
    m.stop();
    expect(m.getState()).toBe("off");
    expect(m.lastError()).toBeNull();
  });

  it("stop() during a start that ultimately fails does not resurrect a failed state", async () => {
    const { m, states, releaseStart } = env({ deferStart: true, failStart: true });
    const applyPromise = m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    await vi.waitFor(() => expect(states).toContain("starting"));
    m.stop();
    releaseStart(0);
    await applyPromise;
    expect(m.getState()).toBe("off");
    expect(m.lastError()).toBeNull();
  });

  it("re-applying identical prefs restarts a server that died on its own (isReady(), not raw state)", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    servers[0]!.stop(); // the child process dies by itself; state is still "ready"
    expect(m.getState()).toBe("ready");
    expect(m.isReady()).toBe(false);
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    expect(servers).toHaveLength(2);
    expect(m.isReady()).toBe(true);
  });
});

describe("ReplyServerManager — logging", () => {
  it("logs state transitions with state, modelId and ms only", async () => {
    const { m, logger } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    const metas = logger.info.mock.calls.map((c) => JSON.stringify(c));
    expect(metas.some((s) => s.includes('"state":"ready"'))).toBe(true);
    for (const s of metas) expect(s).not.toContain("/models/"); // paths are not needed in the log
  });
});
