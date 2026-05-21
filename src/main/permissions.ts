import { exec } from "node:child_process";
import { promisify } from "node:util";

export type PermissionStatus = "granted" | "denied" | "unknown";

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const execAsync = promisify(exec);

// Probe accessibility by running a no-op AppleScript that requires keystroke
// permission. macOS prompts the user OR throws a permission error.
export async function checkAccessibilityViaProbe(execFn: ExecFn = execAsync): Promise<PermissionStatus> {
  // A no-op System Events command requires Accessibility permission.
  const cmd = `osascript -e 'tell application "System Events" to get name of every process whose visible is true' 2>&1`;
  try {
    await execFn(cmd);
    return "granted";
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes("not authorized") || msg.includes("accessibility") || msg.includes("not allowed")) {
      return "denied";
    }
    return "unknown";
  }
}

// Mic permission via Electron's systemPreferences. Only callable inside the
// Electron main process.
export async function checkMicrophone(): Promise<PermissionStatus> {
  // Lazy import so unit tests don't need Electron available
  const electron = await import("electron");
  const status = electron.systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "unknown"; // "not-determined" — first launch
}
