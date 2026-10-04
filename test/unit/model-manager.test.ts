import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
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
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 5, status: 200 });
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
      status: 200,
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
    const fetcher: DownloadStreamFn = async () => ({ stream: streamOfBytes(payload), contentLength: 3, status: 200 });
    const mgr = new ModelManager(fetcher);

    await expect(mgr.download(desc)).rejects.toThrow(/sha256/i);
    expect(await mgr.isInstalled(desc)).toBe(false);
  });

  it("keeps the partial file on a network failure so the next attempt can resume", async () => {
    // Renamed from "doesn't leave partial files when download fails": the
    // partial is now deliberately kept so downloads can resume.
    const desc: ModelDescriptor = {
      id: "fail", filename: "fail.bin", sizeBytes: 5,
      sha256: sha256(new Uint8Array([1, 2, 3, 4, 5])), url: "https://x",
    };
    const fetcher: DownloadStreamFn = async () => {
      const s = new Readable({ read() {} });
      process.nextTick(() => {
        s.push(Buffer.from([1, 2]));
        setImmediate(() => s.destroy(new Error("network blip")));
      });
      return { stream: s, contentLength: 5, status: 200 };
    };
    const mgr = new ModelManager(fetcher);
    await expect(mgr.download(desc)).rejects.toThrow(/network blip/);
    expect(await mgr.isInstalled(desc)).toBe(false);
    await expect(access(join(dir, "fail.bin.partial"))).resolves.toBeUndefined();
  });

  describe("resume, cancel and disk space", () => {
    const full = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const desc: ModelDescriptor = {
      id: "r", filename: "r.bin", sizeBytes: 10, sha256: sha256(full), url: "https://x/r.bin",
    };
    const roomy = async () => ({ bavail: 1_000_000, bsize: 4096 });

    it("aborting mid-download rejects with AbortError and keeps the partial", async () => {
      const ctrl = new AbortController();
      const fetcher: DownloadStreamFn = async (req) => {
        const s = new Readable({ read() {} });
        process.nextTick(() => {
          s.push(Buffer.from(full.subarray(0, 4)));
          setImmediate(() => ctrl.abort());
        });
        expect(req.signal).toBe(ctrl.signal);
        return { stream: s, contentLength: 10, status: 200 };
      };
      const mgr = new ModelManager({ fetcher, statfs: roomy });
      const err = await mgr.download(desc, undefined, { signal: ctrl.signal }).catch((e) => e);
      expect(err.name).toBe("AbortError");
      await expect(access(join(dir, "r.bin.partial"))).resolves.toBeUndefined();
      expect(await mgr.isInstalled(desc)).toBe(false);
    });

    it("resumes from the partial with a Range start and produces a correct file", async () => {
      await writeFile(join(dir, "r.bin.partial"), full.subarray(0, 4));
      const reqs: Array<{ url: string; rangeStart: number }> = [];
      const fetcher: DownloadStreamFn = async (req) => {
        reqs.push({ url: req.url, rangeStart: req.rangeStart });
        return { stream: streamOfBytes(full.subarray(4)), contentLength: 6, status: 206 };
      };
      const mgr = new ModelManager({ fetcher, statfs: roomy });
      const progress: Array<{ bytes: number; total: number }> = [];
      await mgr.download(desc, (p) => progress.push(p));
      expect(reqs).toEqual([{ url: "https://x/r.bin", rangeStart: 4 }]);
      expect(new Uint8Array(await readFile(join(dir, "r.bin")))).toEqual(full);
      expect(progress[0]!.bytes).toBeGreaterThanOrEqual(5); // starts from partialSize
      expect(progress.at(-1)).toEqual({ bytes: 10, total: 10 });
    });

    it("restarts from zero when the server ignores Range (200 instead of 206)", async () => {
      await writeFile(join(dir, "r.bin.partial"), full.subarray(0, 4));
      const fetcher: DownloadStreamFn = async () => ({
        stream: streamOfBytes(full), contentLength: 10, status: 200,
      });
      const mgr = new ModelManager({ fetcher, statfs: roomy });
      await mgr.download(desc);
      expect(new Uint8Array(await readFile(join(dir, "r.bin")))).toEqual(full);
    });

    it("deletes the partial on sha256 mismatch", async () => {
      const bad = { ...desc, sha256: "0".repeat(64) };
      const mgr = new ModelManager({
        fetcher: async () => ({ stream: streamOfBytes(full), contentLength: 10, status: 200 }),
        statfs: roomy,
      });
      await expect(mgr.download(bad)).rejects.toThrow(/sha256/);
      await expect(access(join(dir, "r.bin.partial"))).rejects.toThrow();
    });

    it("deletes the partial on size mismatch", async () => {
      const mgr = new ModelManager({
        fetcher: async () => ({ stream: streamOfBytes(full.subarray(0, 7)), contentLength: 7, status: 200 }),
        statfs: roomy,
      });
      await expect(mgr.download(desc)).rejects.toThrow(/size mismatch/);
      await expect(access(join(dir, "r.bin.partial"))).rejects.toThrow();
    });

    it("checks free space for the remaining bytes before fetching", async () => {
      await writeFile(join(dir, "r.bin.partial"), full.subarray(0, 4));
      const needs: number[] = [];
      let fetched = false;
      const mgr = new ModelManager({
        fetcher: async () => { fetched = true; return { stream: streamOfBytes(full.subarray(4)), contentLength: 6, status: 206 }; },
        // 6 needed * 1.05 = 6.3 > 6 free
        statfs: async (d) => { needs.push(1); expect(d).toBe(dir); return { bavail: 6, bsize: 1 }; },
      });
      await expect(mgr.download(desc)).rejects.toMatchObject({ needBytes: 6, haveBytes: 6 });
      expect(needs.length).toBe(1);
      expect(fetched).toBe(false);
    });

    it("still accepts a bare fetcher function as the constructor argument", async () => {
      const mgr = new ModelManager(async () => ({ stream: streamOfBytes(full), contentLength: 10, status: 200 }));
      await mgr.download(desc);
      expect(await mgr.isInstalled(desc)).toBe(true);
    });
  });

  it("isInstalled validates size too, not just presence", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const desc: ModelDescriptor = {
      id: "size", filename: "size.bin", sizeBytes: 5, sha256: sha256(payload), url: "https://x",
    };
    // Write a file of wrong size at the expected path
    await writeFile(join(dir, "size.bin"), new Uint8Array([1, 2, 3]));
    const mgr = new ModelManager(async () => ({ stream: streamOfBytes(payload), contentLength: 5, status: 200 }));
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
