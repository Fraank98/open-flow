import { describe, it, expect } from "vitest";
import { replyChangesToApply, validateReplyAccelerator, isSystemReservedKeyEvent, reconcileReplyAccelerator, REPLY_HOTKEY_DEFAULT } from "../../src/main/utils/reply-hotkey.js";

describe("validateReplyAccelerator", () => {
  it("accepts the default and other Command/Control/Shift combinations", () => {
    expect(REPLY_HOTKEY_DEFAULT).toBe("Command+Control+R");
    for (const a of ["Command+Control+R", "Cmd+Ctrl+R", "CommandOrControl+Shift+R", "Control+Shift+F12", "Super+Control+Space"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: true, accelerator: a });
    }
  });
  it("rejects any accelerator containing Alt or Option, in any case", () => {
    for (const a of ["Alt+R", "Option+R", "Command+Alt+R", "command+option+r", "AltGr+R"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "contains-option" });
    }
  });
  it("rejects an accelerator without a modifier or without a key", () => {
    expect(validateReplyAccelerator("R")).toEqual({ ok: false, reason: "no-modifier" });
    expect(validateReplyAccelerator("Command+Control")).toEqual({ ok: false, reason: "no-key" });
    expect(validateReplyAccelerator("")).toEqual({ ok: false, reason: "no-key" });
    expect(validateReplyAccelerator("Command++R")).toEqual({ ok: false, reason: "no-key" });
  });
  it("rejects Shift without Command or Control: it would take over normal typing", () => {
    for (const a of ["Shift+Tab", "Shift+R", "Shift+F5"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "shift-only" });
    }
  });
  it("rejects the Command key equivalents of macOS and the app, whatever the spelling", () => {
    for (const a of ["Command+Q", "Cmd+W", "CommandOrControl+H", "Command+M", "Command+Tab", "Command+Space", "Command+,", "Command+`", "command+q", "Super+Q"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "system-reserved" });
    }
  });
  it("lets the same keys through with another modifier combination", () => {
    for (const a of ["Command+Control+Q", "Control+Q", "Command+Shift+Q", "Command+Control+Space", "Control+Tab"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: true, accelerator: a });
    }
  });
  it("rejects the bare digits 1-3 and Escape as the key: they are the pill's temporary shortcuts", () => {
    for (const a of ["Command+1", "Command+2", "Command+3", "Control+Escape"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "reserved-key" });
    }
  });
});

describe("reconcileReplyAccelerator", () => {
  it("rebuilds when the saved (valid) accelerator differs from the current one", () => {
    expect(reconcileReplyAccelerator("Command+Control+T", "Command+Control+R"))
      .toEqual({ accelerator: "Command+Control+T", rebuild: true });
  });
  it("does not rebuild when the saved accelerator already matches the current one", () => {
    expect(reconcileReplyAccelerator("Command+Control+R", "Command+Control+R"))
      .toEqual({ accelerator: "Command+Control+R", rebuild: false });
  });
  it("falls back to the default (not the raw invalid value) when the saved accelerator is invalid", () => {
    expect(reconcileReplyAccelerator("Alt+R", "Command+Control+R"))
      .toEqual({ accelerator: REPLY_HOTKEY_DEFAULT, rebuild: false });
  });
  it("still signals rebuild when falling back to the default and the current wired value differs from it", () => {
    expect(reconcileReplyAccelerator("Alt+R", "Command+Control+T"))
      .toEqual({ accelerator: REPLY_HOTKEY_DEFAULT, rebuild: true });
  });
});

describe("isSystemReservedKeyEvent", () => {
  const press = (key: string, extra: object = {}) => isSystemReservedKeyEvent({ key, meta: true, control: false, shift: false, alt: false, ...extra });

  it("is true for Command plus Q, W, H, M, Tab, Space, comma or backtick", () => {
    for (const key of ["q", "W", "h", "m", "Tab", " ", ",", "`"]) expect(press(key), key).toBe(true);
  });
  it("is false for other keys and for any extra modifier", () => {
    expect(press("r")).toBe(false);
    expect(press("q", { shift: true })).toBe(false);
    expect(press("q", { control: true })).toBe(false);
    expect(press("q", { alt: true })).toBe(false);
    expect(press("q", { meta: false })).toBe(false);
  });
});

describe("replyChangesToApply", () => {
  const base = { replySuggestionsEnabled: true, replyModelId: "gemma-3-4b", replySuggestionsHotkey: "Command+Control+R" };

  it("applies nothing when an unrelated preference was saved", () => {
    expect(replyChangesToApply(base, { ...base })).toEqual({ server: false, hotkey: false });
  });
  it("restarts the server only for the toggle or the model, and rewires the hotkey for the toggle or the shortcut", () => {
    expect(replyChangesToApply(base, { ...base, replySuggestionsEnabled: false })).toEqual({ server: true, hotkey: true });
    expect(replyChangesToApply(base, { ...base, replyModelId: "gemma-4-e4b" })).toEqual({ server: true, hotkey: false });
    expect(replyChangesToApply(base, { ...base, replySuggestionsHotkey: "Command+Shift+K" })).toEqual({ server: false, hotkey: true });
  });
});
