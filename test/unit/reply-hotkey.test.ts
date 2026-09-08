import { describe, it, expect } from "vitest";
import { validateReplyAccelerator, REPLY_HOTKEY_DEFAULT } from "../../src/main/utils/reply-hotkey.js";

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
  it("rejects the bare digits 1-3 and Escape as the key: they are the pill's temporary shortcuts", () => {
    for (const a of ["Command+1", "Command+2", "Command+3", "Control+Escape"]) {
      expect(validateReplyAccelerator(a), a).toEqual({ ok: false, reason: "reserved-key" });
    }
  });
});
