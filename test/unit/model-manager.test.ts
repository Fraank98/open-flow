import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { ModelManager, DownloadStreamFn } from "../../src/main/model-manager.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

function streamOfBytes(bytes: Uint8Array): Readable {
  return Readable.from([bytes]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ModelManager", () => {
  let dir: string;
  beforeEach(async () => {
    process.env.OPEN_FLOW_MODELS_DIR = await mkdtemp(join(tmpdir(), "of-models-"));
    dir = process.env.OPEN_FLOW_MODELS_DIR;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.OPEN_FLOW_MODELS_DIR;
  });

  it("reports isInstalled=false before download, true after", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const desc: ModelDescriptor = {
      id: "test", filename: "test.bin", sizeBytes: 5, sha256: sha256(payload), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 5 });
    const mgr = new ModelManager(fetcher);

    expect(await mgr.isInstalled(desc)).toBe(false);
    await mgr.download(desc);
    expect(await mgr.isInstalled(desc)).toBe(true);
  });

  it("reports progress during download", async () => {
    const payload = new Uint8Array(100).fill(0);
    const desc: ModelDescriptor = {
      id: "p", filename: "p.bin", sizeBytes: 100, sha256: sha256(payload), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({
      stream: Readable.from([payload.subarray(0, 30), payload.subarray(30, 70), payload.subarray(70)]),
      contentLength: 100,
    });
    const mgr = new ModelManager(fetcher);
    const progress: Array<{ bytes: number; total: number }> = [];
    await mgr.download(desc, (p) => progress.push(p));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]?.bytes).toBe(100);
    expect(progress.every((p) => p.total === 100)).toBe(true);
  });

  it("rejects when downloaded sha256 doesn't match descriptor", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const desc: ModelDescriptor = {
      id: "bad", filename: "bad.bin", sizeBytes: 3,
      sha256: "0".repeat(64), // wrong
      url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 3 });
    const mgr = new ModelManager(fetcher);

    await expect(mgr.download(desc)).rejects.toThrow(/sha256/i);
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("doesn't leave partial files when download fails", async () => {
    const desc: ModelDescriptor = {
      id: "fail", filename: "fail.bin", sizeBytes: 5,
      sha256: sha256(new Uint8Array([1, 2, 3, 4, 5])), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => s.destroy(new Error("network blip")));
      return { stream: s, contentLength: 5 };
    };
    const mgr = new ModelManager(fetcher);
    await expect(mgr.download(desc)).rejects.toThrow(/network blip/);
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("isInstalled validates size too, not just presence", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const desc: ModelDescriptor = {
      id: "size", filename: "size.bin", sizeBytes: 5, sha256: sha256(payload), url: "https://x",
    };
    // Write a file of wrong size at the expected path
    await writeFile(join(dir, "size.bin"), new Uint8Array([1, 2, 3]));
    const mgr = new ModelManager(async () => ({ stream: streamOfBytes(payload), contentLength: 5 }));
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("getInstalledPath returns absolute path", async () => {
    const desc: ModelDescriptor = {
      id: "p", filename: "p.bin", sizeBytes: 0, sha256: "0".repeat(64), url: "https://x",
    };
    const mgr = new ModelManager(async () => { throw new Error("unused"); });
    const path = mgr.getInstalledPath(desc);
    expect(path).toContain("p.bin");
    expect(path.startsWith("/")).toBe(true);
  });
});
