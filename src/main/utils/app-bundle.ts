import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Runs a command without a shell and resolves with its stdout. */
export type ExecFn = (file: string, args: string[]) => Promise<string>;

// A reverse-DNS bundle id: no spaces, no path separators, no quotes. Anything
// else must never reach a command line or a Spotlight query.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isBundleId(value: string): boolean {
  return BUNDLE_ID.test(value);
}

/** "/Applications/Google Chrome.app" -> "Google Chrome". */
export function appNameFromPath(appPath: string): string {
  return basename(appPath.replace(/\/+$/, "")).replace(/\.app$/i, "");
}

async function tryExec(exec: ExecFn, file: string, args: string[]): Promise<string | null> {
  try {
    const out = (await exec(file, args)).trim();
    return isBundleId(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Reads an app's bundle id: Spotlight metadata first (`mdls`), then the
 * bundle's Info.plist (`plutil`) for apps Spotlight doesn't know about.
 */
export async function readBundleId(appPath: string, exec: ExecFn): Promise<string | null> {
  const viaSpotlight = await tryExec(exec, "mdls", ["-name", "kMDItemCFBundleIdentifier", "-raw", appPath]);
  if (viaSpotlight) return viaSpotlight;
  return tryExec(exec, "plutil", ["-extract", "CFBundleIdentifier", "raw", `${appPath.replace(/\/+$/, "")}/Contents/Info.plist`]);
}

/**
 * Finds where an app with this bundle id is installed (Spotlight), or null.
 * The search is limited to the application folders: an unrestricted mdfind also
 * walks every build output and backup copy of the app on the disk, which is slow.
 */
export async function findAppPathByBundleId(bundleId: string, exec: ExecFn, home: string = homedir()): Promise<string | null> {
  if (!isBundleId(bundleId)) return null;
  try {
    const out = await exec("mdfind", [
      "-onlyin", "/Applications",
      "-onlyin", join(home, "Applications"),
      "-onlyin", "/System/Applications",
      `kMDItemCFBundleIdentifier == '${bundleId}'`,
    ]);
    return out.split("\n").map((l) => l.trim()).find((l) => l.endsWith(".app")) ?? null;
  } catch {
    return null;
  }
}

/** Like Promise.all(items.map(fn)), but with at most `limit` calls in flight; results keep the input order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
