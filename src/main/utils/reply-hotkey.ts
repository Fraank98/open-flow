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
