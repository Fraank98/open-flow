import { describe, it, expect, vi } from "vitest";
import { ReplyServerManager, type ReplyServerLike } from "../../src/main/reply-server-manager.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

function fakeServer(opts: { failStart?: boolean } = {}) {
  let running = false;
  const s: ReplyServerLike & { startCalls: number; stopCalls: number } = {
    startCalls: 0, stopCalls: 0,
    async start() { s.startCalls += 1; if (opts.failStart) throw new Error("llama-server did not become healthy within 90000ms"); running = true; },
    stop() { s.stopCalls += 1; running = false; },
    isRunning: () => running,
    getEndpoint: () => "http://127.0.0.1:18082",
  };
  return s;
}

function env(over: { installed?: string[]; failStart?: boolean; failDownload?: boolean } = {}) {
  const installed = new Set(over.installed ?? ["gemma-3-4b-it-Q4_K_M.gguf"]);
  const servers: Array<ReturnType<typeof fakeServer> & { modelPath: string }> = [];
  const download = vi.fn(async (desc: ModelDescriptor, onProgress?: (p: { bytes: number; total: number }) => void) => {
    if (over.failDownload) throw new Error("sha256 mismatch");
    onProgress?.({ bytes: 1, total: 2 });
    installed.add(desc.filename);
  });
  const logger = { info: vi.fn(async () => {}), warn: vi.fn(async () => {}), error: vi.fn(async () => {}) };
  const states: string[] = [];
  const m = new ReplyServerManager({
    createServer: (modelPath) => { const s = Object.assign(fakeServer({ failStart: over.failStart }), { modelPath }); servers.push(s); return s; },
    modelManager: {
      isInstalled: async (d) => installed.has(d.filename),
      download,
      getInstalledPath: (d) => `/models/${d.filename}`,
    },
    logger,
  });
  m.onStateChange((s) => states.push(s));
  return { m, servers, download, logger, states };
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
});

describe("ReplyServerManager.stop", () => {
  it("stops a running server and reports off (used on will-quit)", async () => {
    const { m, servers } = env();
    await m.apply({ enabled: true, replyModelId: "gemma-3-4b" });
    m.stop();
    expect(servers[0]!.stopCalls).toBe(1);
    expect(m.getState()).toBe("off");
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
