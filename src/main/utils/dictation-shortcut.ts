/** NSEvent modifier flags; keep these values in sync with ptt-gesture.h. */
const SHIFT = 1 << 17, CONTROL = 1 << 18, OPTION = 1 << 19, COMMAND = 1 << 20;
// Command alone is reserved for reply selection (Cmd+1/2/3).
export const DICTATION_SHORTCUTS = [
  { id: "Hold Option", label: "⌥ Option", mask: OPTION },
  { id: "Hold Control", label: "⌃ Control", mask: CONTROL },
  { id: "Hold Shift", label: "⇧ Shift", mask: SHIFT },
  { id: "Hold Control+Option", label: "⌃⌥ Control + Option", mask: CONTROL | OPTION },
  { id: "Hold Control+Shift", label: "⌃⇧ Control + Shift", mask: CONTROL | SHIFT },
  { id: "Hold Control+Command", label: "⌃⌘ Control + Command", mask: CONTROL | COMMAND },
] as const;

/** Invalid/legacy values retain the original Hold Option behaviour. */
export function dictationShortcut(value: unknown) {
  return DICTATION_SHORTCUTS.find(s => s.id === value) ?? DICTATION_SHORTCUTS[0];
}

export function isDictationShortcut(value: unknown): value is string {
  return DICTATION_SHORTCUTS.some(s => s.id === value);
}
