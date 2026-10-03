import { basename } from "node:path";

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

/** Finds where an app with this bundle id is installed (Spotlight), or null. */
export async function findAppPathByBundleId(bundleId: string, exec: ExecFn): Promise<string | null> {
  if (!isBundleId(bundleId)) return null;
  try {
    const out = await exec("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`]);
    return out.split("\n").map((l) => l.trim()).find((l) => l.endsWith(".app")) ?? null;
  } catch {
    return null;
  }
}
