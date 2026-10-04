import { createWriteStream } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname } from "node:path";
import { ensureFreeSpace, StatfsFn } from "./utils/disk-space.js";
import { modelFilePath, sha256OfFile, fileSize, ModelDescriptor } from "./utils/model-paths.js";

export interface ProgressEvent {
  bytes: number;
  total: number;
}

export type ProgressCallback = (p: ProgressEvent) => void;

export interface DownloadRequest {
  url: string;
  /** First byte to fetch; 0 for a fresh download. */
  rangeStart: number;
  signal?: AbortSignal;
}

export interface DownloadResponse {
  stream: Readable;
  /** Length of THIS response body (remaining bytes when status is 206). */
  contentLength: number;
  /** 206 when the server honoured the Range request, 200 when it sent the whole file. */
  status: number;
}

export type DownloadStreamFn = (req: DownloadRequest) => Promise<DownloadResponse>;

export interface DownloadOptions {
  signal?: AbortSignal;
}

export interface ModelManagerOptions {
  fetcher?: DownloadStreamFn;
  statfs?: StatfsFn;
}

// Default fetcher uses Node's global fetch (Node 20+).
export const defaultFetcher: DownloadStreamFn = async ({ url, rangeStart, signal }) => {
  const res = await fetch(url, {
    headers: rangeStart > 0 ? { Range: `bytes=${rangeStart}-` } : {},
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  // Convert WHATWG ReadableStream to Node Readable
  const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
  return { stream, contentLength, status: res.status };
};

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export class ModelManager {
  private readonly fetcher: DownloadStreamFn;
  private readonly statfs: StatfsFn | undefined;

  /** Accepts options, or a bare fetcher function for backwards compatibility. */
  constructor(opts: ModelManagerOptions | DownloadStreamFn = {}) {
    const o = typeof opts === "function" ? { fetcher: opts } : opts;
    this.fetcher = o.fetcher ?? defaultFetcher;
    this.statfs = o.statfs;
  }

  getInstalledPath(desc: ModelDescriptor): string {
    return modelFilePath(desc);
  }

  async isInstalled(desc: ModelDescriptor): Promise<boolean> {
    const path = this.getInstalledPath(desc);
    try {
      await access(path);
    } catch {
      return false;
    }
    const size = await fileSize(path);
    if (size !== desc.sizeBytes) return false;
    // Skip sha256 here — it's a cheap-vs-correct trade-off. Size guards most
    // corruption; full sha is verified at download time.
    return true;
  }

  /**
   * Deletes a model file and any `<file>.partial` it left behind. A missing file
   * is fine; any other failure (permissions, a directory in the way) is thrown so
   * the caller can tell the user instead of showing a phantom success.
   */
  async deleteModel(desc: ModelDescriptor): Promise<void> {
    const path = this.getInstalledPath(desc);
    await unlinkIfExists(path);
    await unlinkIfExists(`${path}.partial`);
  }

  /**
   * Removes the `.partial` of every model in `all` that is not in `keep`. A
   * download the user cancelled or abandoned for another tier leaves up to GBs
   * behind that nothing would ever resume; finished files are never touched.
   */
  async removeOrphanPartials(keep: readonly ModelDescriptor[], all: readonly ModelDescriptor[]): Promise<void> {
    const keepIds = new Set(keep.map((d) => d.id));
    for (const desc of all) {
      if (!keepIds.has(desc.id)) await unlinkIfExists(`${this.getInstalledPath(desc)}.partial`);
    }
  }

  /**
   * Downloads into `<file>.partial`, resuming from it when present. The partial
   * survives aborts and network errors; it is deleted only when the finished
   * file fails the size or sha256 check.
   */
  async download(desc: ModelDescriptor, onProgress?: ProgressCallback, opts: DownloadOptions = {}): Promise<void> {
    const finalPath = this.getInstalledPath(desc);
    const tmpPath = `${finalPath}.partial`;
    const dir = dirname(finalPath);
    await mkdir(dir, { recursive: true });

    let partialSize = await fileSize(tmpPath).catch(() => 0);
    if (partialSize > desc.sizeBytes && desc.sizeBytes > 0) {
      await unlink(tmpPath).catch(() => undefined);
      partialSize = 0;
    }
    await ensureFreeSpace(dir, Math.max(0, desc.sizeBytes - partialSize), this.statfs);

    // A partial that already has every byte only needs verification (a Range
    // request past the end would come back as 416).
    if (partialSize === 0 || partialSize < desc.sizeBytes) {
      opts.signal?.throwIfAborted();
      const { stream, contentLength, status } = await this.fetcher({
        url: desc.url,
        rangeStart: partialSize,
        signal: opts.signal,
      });
      const resumed = partialSize > 0 && status === 206;
      const startBytes = resumed ? partialSize : 0;
      const total = contentLength > 0 ? startBytes + contentLength : desc.sizeBytes;
      let received = startBytes;

      const progress = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          if (onProgress) onProgress({ bytes: received, total });
          cb(null, chunk);
        },
      });

      // Append when the server honoured the Range; otherwise start the file over.
      await pipeline(stream, progress, createWriteStream(tmpPath, { flags: resumed ? "a" : "w" }), {
        signal: opts.signal,
      });
    }

    // Verify size then sha256
    const downloadedSize = await fileSize(tmpPath);
    if (downloadedSize !== desc.sizeBytes && desc.sizeBytes > 0) {
      await unlink(tmpPath).catch(() => undefined);
      throw new Error(`size mismatch: expected ${desc.sizeBytes}, got ${downloadedSize}`);
    }
    const actualSha = await sha256OfFile(tmpPath);
    if (actualSha !== desc.sha256) {
      await unlink(tmpPath).catch(() => undefined);
      throw new Error(`sha256 mismatch for ${desc.filename}: expected ${desc.sha256}, got ${actualSha}`);
    }
    await rename(tmpPath, finalPath);
  }
}
