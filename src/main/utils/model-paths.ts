import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelDescriptor {
  id: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  url: string;
}

export function getModelsDir(): string {
  if (process.env.OPEN_FLOW_MODELS_DIR) {
    return process.env.OPEN_FLOW_MODELS_DIR;
  }
  // macOS default
  return join(homedir(), "Library", "Application Support", "open-flow", "models");
}

export function modelFilePath(desc: ModelDescriptor): string {
  return join(getModelsDir(), desc.filename);
}

export async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}
