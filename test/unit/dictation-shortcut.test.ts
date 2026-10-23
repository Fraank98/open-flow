import { describe, expect, it } from "vitest";
import { dictationShortcut, DICTATION_SHORTCUTS } from "../../src/main/utils/dictation-shortcut.js";
import { sanitizePrefsPatch } from "../../src/main/utils/prefs-patch.js";
import { restartRequiredFields } from "../../src/main/utils/restart-required.js";
import { DEFAULT_PREFS } from "../../src/main/preferences-store.js";

describe("dictation shortcut", () => {
  it("defaults invalid and legacy preferences to Option", () => {
    for (const value of [undefined, null, "Control+R", "", 123]) {
      expect(dictationShortcut(value).id).toBe("Hold Option");
      expect(dictationShortcut(value).mask).toBe(1 << 19);
    }
  });
  it("passes only supported hold gestures through settings", () => {
    for (const shortcut of DICTATION_SHORTCUTS) {
      expect(sanitizePrefsPatch({ hotkeyAccelerator: shortcut.id })).toEqual({ hotkeyAccelerator: shortcut.id });
    }
    expect(sanitizePrefsPatch({ hotkeyAccelerator: "Command+Q" })).toEqual({});
    // Command alone dismisses reply suggestions before Cmd+1/2/3 can select one.
    expect(sanitizePrefsPatch({ hotkeyAccelerator: "Hold Command" })).toEqual({});
    expect(dictationShortcut("Hold Command").id).toBe("Hold Option");
    expect(sanitizePrefsPatch({ hotkeyAccelerator: 5 })).toEqual({});
  });
  it("maps a two-modifier gesture to both native flags", () => {
    expect(dictationShortcut("Hold Control+Command").mask).toBe((1 << 18) | (1 << 20));
  });
  it("requests a restart for a changed gesture and clears it on revert", () => {
    expect(restartRequiredFields(DEFAULT_PREFS, {...DEFAULT_PREFS, hotkeyAccelerator: "Hold Control"})).toEqual(["hotkeyAccelerator"]);
    expect(restartRequiredFields(DEFAULT_PREFS, {...DEFAULT_PREFS})).toEqual([]);
  });
});
