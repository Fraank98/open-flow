import { createWriteStream } from "node:fs";
import { access, mkdir, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname } from "node:path";
import { modelFilePath, sha256OfFile, fileSize, ModelDescriptor } from "./utils/model-paths.js";

export interface ProgressEvent {
  bytes: number;
  total: number;
}

export type ProgressCallback = (p: ProgressEvent) => void;

export interface DownloadResponse {
  stream: Readable;
  contentLength: number;
}

export type DownloadStreamFn = (url: string) => Promise<DownloadResponse>;

// Default fetcher uses Node's global fetch (Node 20+).
export const defaultFetcher: DownloadStreamFn = async (url) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? "0");
  // Convert WHATWG ReadableStream to Node Readable
  const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
  return { stream, contentLength };
};

export class ModelManager {
  constructor(private readonly fetcher: DownloadStreamFn = defaultFetcher) {}

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

  async download(desc: ModelDescriptor, onProgress?: ProgressCallback): Promise<void> {
    const finalPath = this.getInstalledPath(desc);
    const tmpPath = `${finalPath}.partial`;
    await mkdir(dirname(finalPath), { recursive: true });

    const { stream, contentLength } = await this.fetcher(desc.url);
    const total = contentLength > 0 ? contentLength : desc.sizeBytes;
    let received = 0;

    const progress = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (onProgress) onProgress({ bytes: received, total });
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, progress, createWriteStream(tmpPath));
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
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
