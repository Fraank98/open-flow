import { statfs } from "node:fs/promises";
import { formatBytes } from "./format-bytes.js";

export class InsufficientSpaceError extends Error {
  constructor(
    readonly needBytes: number,
    readonly haveBytes: number,
  ) {
    super(`Not enough disk space: need ${formatBytes(needBytes)}, have ${formatBytes(haveBytes)}`);
    this.name = "InsufficientSpaceError";
  }
}

export type StatfsFn = (dir: string) => Promise<{ bavail: number; bsize: number }>;

const defaultStatfs: StatfsFn = async (dir) => {
  const s = await statfs(dir);
  return { bavail: Number(s.bavail), bsize: Number(s.bsize) };
};

/** Free-space margin on top of the bytes still to download (filesystem overhead, other writers). */
const MARGIN = 1.05;

/** Returns the free bytes, or throws InsufficientSpaceError if free < needed * 1.05. */
export async function ensureFreeSpace(
  dir: string,
  neededBytes: number,
  statfsFn: StatfsFn = defaultStatfs,
): Promise<number> {
  const { bavail, bsize } = await statfsFn(dir);
  const free = bavail * bsize;
  if (neededBytes > 0 && free < neededBytes * MARGIN) {
    throw new InsufficientSpaceError(neededBytes, free);
  }
  return free;
}
