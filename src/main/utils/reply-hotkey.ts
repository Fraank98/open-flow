/**
 * Validates the reply-suggestions accelerator without touching Electron.
 * Option/Alt is forbidden: dictation is "Hold Option" through the native
 * modifier monitor, and Option inside a chord would fire `arm` on the PTT
 * (then a CHORD that cancels it, with a flicker of the recording pill).
 * Command+1/2/3 and Escape are the pill's temporary shortcuts (Task 8):
 * they cannot also be the trigger.
 */
export const REPLY_HOTKEY_DEFAULT: string = "Command+Control+R";

export type AcceleratorValidation =
  | { ok: true; accelerator: string }
  | { ok: false; reason: "contains-option" | "no-modifier" | "no-key" | "reserved-key" };

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "shift", "super", "meta"]);
const OPTION_LIKE = new Set(["alt", "option", "altgr"]);
const RESERVED_KEYS = new Set(["1", "2", "3", "escape", "esc"]);

export function validateReplyAccelerator(accelerator: string): AcceleratorValidation {
  const parts = accelerator.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return { ok: false, reason: "no-key" };
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some((p) => OPTION_LIKE.has(p))) return { ok: false, reason: "contains-option" };
  const keys = lower.filter((p) => !MODIFIERS.has(p));
  const modifiers = lower.filter((p) => MODIFIERS.has(p));
  if (keys.length !== 1) return { ok: false, reason: "no-key" };
  if (modifiers.length === 0) return { ok: false, reason: "no-modifier" };
  if (RESERVED_KEYS.has(keys[0]!)) return { ok: false, reason: "reserved-key" }; // keys.length === 1, so keys[0] exists
  return { ok: true, accelerator };
}

export interface ReplyHotkeyReconciliation {
  /** The accelerator to have wired: the saved preference if valid, else the
   *  default — same fallback used at boot. */
  accelerator: string;
  /** True when this differs from `current`, i.e. the caller must unregister
   *  the old accelerator and construct a fresh HotkeyManager with this one:
   *  HotkeyManager's accelerator is immutable once constructed (its `opts`
   *  is `readonly`), so a saved change can only take effect by swapping the
   *  instance, never by mutating it in place. */
  rebuild: boolean;
}

/**
 * Pure decision for whether the reply hotkey needs to be rebuilt after the
 * user saves a new accelerator in Preferences. index.ts owns the actual
 * side effects (unregistering the old accelerator, constructing the new
 * HotkeyManager, re-registering); this only decides the value and whether
 * it changed, so it's testable without mocking Electron's globalShortcut.
 */
export function reconcileReplyAccelerator(savedPreference: string, current: string): ReplyHotkeyReconciliation {
  const accelerator = validateReplyAccelerator(savedPreference).ok ? savedPreference : REPLY_HOTKEY_DEFAULT;
  return { accelerator, rebuild: accelerator !== current };
}
