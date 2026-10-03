import { exec } from "node:child_process";
import { promisify } from "node:util";

export type PermissionStatus = "granted" | "denied" | "unknown";

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

const execAsync = promisify(exec);

/** Longest the Automation probe may wait for an answer (an unanswered macOS prompt never returns). */
const PROBE_TIMEOUT_MS = 15_000;

/** The slice of the native PTT addon that reads/requests the AX trust. */
export interface AccessibilityNative {
  isTrusted(): boolean;
  requestTrust(): boolean;
}

/** Accessibility, read live from the AX API (`AXIsProcessTrusted`) — the same call the PTT monitor depends on. */
export function checkAccessibility(native: Pick<AccessibilityNative, "isTrusted">): PermissionStatus {
  return native.isTrusted() ? "granted" : "denied";
}

/**
 * Asks macOS for Accessibility (`AXIsProcessTrustedWithOptions(prompt)`), which
 * is what makes open-flow appear in System Settings > Accessibility. Calls
 * `requestTrust()` exactly once and returns the resulting status.
 */
export function requestAccessibility(native: AccessibilityNative): PermissionStatus {
  native.requestTrust();
  return checkAccessibility(native);
}

export interface PermissionSet {
  mic: PermissionStatus;
  accessibility: PermissionStatus;
  automation: PermissionStatus;
}

/** Setup can continue only when all three are granted (Automation is required for the Cmd+V paste). */
export function permissionsReady(p: PermissionSet): boolean {
  return p.mic === "granted" && p.accessibility === "granted" && p.automation === "granted";
}

// Probe Automation (Apple Events to System Events) with a no-op AppleScript.
// This is NOT the Accessibility permission: macOS either prompts the user once
// or throws a "not authorized" error. The paste (Cmd+V via System Events)
// needs both Accessibility and Automation.
export async function checkAutomationViaProbe(
  execFn: ExecFn = (cmd) => execAsync(cmd, { timeout: PROBE_TIMEOUT_MS }),
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<PermissionStatus> {
  const cmd = `osascript -e 'tell application "System Events" to get name of every process whose visible is true' 2>&1`;
  // With the macOS prompt left unanswered osascript blocks until someone clicks,
  // so the probe is bounded: past the timeout the answer is simply "unknown".
  // (The default exec also kills the process; the race covers injected fakes.)
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([execFn(cmd), timedOut]);
    return outcome === "timeout" ? "unknown" : "granted";
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes("not authorized") || msg.includes("accessibility") || msg.includes("not allowed")) {
      return "denied";
    }
    return "unknown";
  } finally {
    clearTimeout(timer);
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
