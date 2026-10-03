import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/settings-logic.js";

interface ReplyLogic {
  replyGuardMessage(input: { name: string; modelInstalled: boolean; tierLabel: string; nativeOk: boolean }): string;
  acceleratorLabel(accelerator: string): string;
  replyStatusView(
    status: { serverState: string; hotkeyRegistered: boolean; nativeOk: boolean },
    accelerator: string,
  ): { text: string; tone: "ok" | "busy" | "error" | "none"; action: "retry" | null };
  acceleratorFromKeyEvent(ev: {
    code: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  }): string | null;
  hotkeyReasonText(reason: string | undefined): string;
  appRowLabel(bundleId: string, info?: { name: string | null } | null): { primary: string; secondary: string | null };
  replyAppsView(mode: string, appCount: number): { label: string; warning: string | null };
}
const L = (globalThis as unknown as { OpenFlowSettingsLogic: ReplyLogic }).OpenFlowSettingsLogic;

describe("replyGuardMessage", () => {
  const ok = { name: "Danilo", modelInstalled: true, tierLabel: "Standard", nativeOk: true };

  it("lists what is missing under the toggle, in plain English", () => {
    expect(L.replyGuardMessage({ ...ok, name: "", modelInstalled: false })).toBe(
      "To turn this on: enter your name and download the Standard model.",
    );
    expect(L.replyGuardMessage({ ...ok, modelInstalled: false })).toBe("To turn this on: download the Standard model.");
    expect(L.replyGuardMessage({ ...ok, name: "" })).toBe("To turn this on: enter your name.");
  });

  it("names the tier that is selected, not a fixed one", () => {
    expect(L.replyGuardMessage({ ...ok, modelInstalled: false, tierLabel: "Maximum quality" })).toBe(
      "To turn this on: download the Maximum quality model.",
    );
  });

  it("is empty when nothing is missing, and treats a blank name as missing", () => {
    expect(L.replyGuardMessage(ok)).toBe("");
    expect(L.replyGuardMessage({ ...ok, name: "   " })).toBe("To turn this on: enter your name.");
  });

  it("says the feature is unavailable when the native reader did not load", () => {
    expect(L.replyGuardMessage({ ...ok, nativeOk: false })).toBe(
      "Reply suggestions are unavailable in this session: the helper that reads conversations didn't load.",
    );
  });
});

describe("replyAppsView", () => {
  it("labels the list by mode, with a warning only where the list changes the meaning", () => {
    expect(L.replyAppsView("allowlist", 3)).toEqual({ label: "Apps to read", warning: null });
    expect(L.replyAppsView("allowlist", 0)).toEqual({ label: "Apps to read", warning: "No app added: nothing will be read." });
    expect(L.replyAppsView("blocklist", 2)).toEqual({ label: "Apps to exclude", warning: "Every other app can be read." });
    expect(L.replyAppsView("blocklist", 0)).toEqual({ label: "Apps to exclude", warning: "No app excluded: every app can be read." });
  });
});

describe("acceleratorLabel", () => {
  it("draws an Electron accelerator the way macOS prints it", () => {
    expect(L.acceleratorLabel("Command+Control+R")).toBe("⌃⌘R");
    expect(L.acceleratorLabel("Command+Shift+K")).toBe("⇧⌘K");
    expect(L.acceleratorLabel("Control+Shift+Command+F5")).toBe("⌃⇧⌘F5");
    expect(L.acceleratorLabel("CommandOrControl+Space")).toBe("⌘Space");
    expect(L.acceleratorLabel("Cmd+Up")).toBe("⌘↑");
  });
});

describe("replyStatusView", () => {
  const base = { serverState: "ready", hotkeyRegistered: true, nativeOk: true };

  it("ready with the shortcut registered names the shortcut that is active", () => {
    expect(L.replyStatusView(base, "Command+Control+R")).toEqual({ text: "Model: ready · ⌃⌘R active", tone: "ok", action: null });
    expect(L.replyStatusView(base, "Command+Shift+K").text).toBe("Model: ready · ⇧⌘K active");
  });

  it("ready but the shortcut was refused says another app owns it", () => {
    expect(L.replyStatusView({ ...base, hotkeyRegistered: false }, "Command+Control+R")).toEqual({
      text: "Shortcut taken by another app — choose another",
      tone: "error",
      action: null,
    });
  });

  it("loading and downloading are busy states", () => {
    expect(L.replyStatusView({ ...base, serverState: "starting" }, "Command+Control+R")).toEqual({ text: "Model: loading…", tone: "busy", action: null });
    expect(L.replyStatusView({ ...base, serverState: "downloading" }, "Command+Control+R")).toEqual({ text: "Model: downloading…", tone: "busy", action: null });
  });

  it("failed offers a Retry", () => {
    expect(L.replyStatusView({ ...base, serverState: "failed" }, "Command+Control+R")).toEqual({
      text: "Model: failed — Retry",
      tone: "error",
      action: "retry",
    });
  });

  it("says nothing while the feature is off or unavailable", () => {
    expect(L.replyStatusView({ ...base, serverState: "off" }, "Command+Control+R")).toEqual({ text: "", tone: "none", action: null });
    expect(L.replyStatusView({ ...base, nativeOk: false }, "Command+Control+R").text).toBe("");
  });
});

describe("acceleratorFromKeyEvent", () => {
  it("composes an Electron accelerator from a keydown, modifiers first", () => {
    expect(L.acceleratorFromKeyEvent({ code: "KeyR", metaKey: true, ctrlKey: true })).toBe("Command+Control+R");
    expect(L.acceleratorFromKeyEvent({ code: "KeyK", metaKey: true, shiftKey: true })).toBe("Command+Shift+K");
    expect(L.acceleratorFromKeyEvent({ code: "F5", ctrlKey: true })).toBe("Control+F5");
    expect(L.acceleratorFromKeyEvent({ code: "Digit1", metaKey: true })).toBe("Command+1");
    expect(L.acceleratorFromKeyEvent({ code: "Space", metaKey: true })).toBe("Command+Space");
    expect(L.acceleratorFromKeyEvent({ code: "ArrowUp", metaKey: true })).toBe("Command+Up");
    expect(L.acceleratorFromKeyEvent({ code: "Slash", metaKey: true, shiftKey: true })).toBe("Command+Shift+/");
  });

  it("keeps Option in the result so the validator can explain why it is refused", () => {
    expect(L.acceleratorFromKeyEvent({ code: "KeyR", metaKey: true, altKey: true })).toBe("Command+Alt+R");
  });

  it("uses the physical key, so Option's dead keys and shifted symbols do not leak in", () => {
    expect(L.acceleratorFromKeyEvent({ code: "KeyE", metaKey: true, altKey: true })).toBe("Command+Alt+E");
    expect(L.acceleratorFromKeyEvent({ code: "Digit1", metaKey: true, shiftKey: true })).toBe("Command+Shift+1");
  });

  it("returns null until a real key is pressed (modifier-only or unknown key)", () => {
    expect(L.acceleratorFromKeyEvent({ code: "MetaLeft", metaKey: true })).toBeNull();
    expect(L.acceleratorFromKeyEvent({ code: "ShiftRight", shiftKey: true })).toBeNull();
    expect(L.acceleratorFromKeyEvent({ code: "Unidentified", metaKey: true })).toBeNull();
  });
});

describe("hotkeyReasonText", () => {
  it("explains every reason the validator can give, in English", () => {
    expect(L.hotkeyReasonText("contains-option")).toBe("Option is used for dictation. Choose another combination.");
    expect(L.hotkeyReasonText("no-modifier")).toBe("Add at least one of Command, Control or Shift.");
    expect(L.hotkeyReasonText("no-key")).toBe("Add a key besides the modifiers.");
    expect(L.hotkeyReasonText("reserved-key")).toBe("1, 2, 3 and Esc are the pill's shortcuts while it is visible.");
    expect(L.hotkeyReasonText(undefined)).toBe("That shortcut isn't valid.");
  });
});

describe("appRowLabel", () => {
  it("shows the readable name with the bundle id as the small line", () => {
    expect(L.appRowLabel("com.apple.mail", { name: "Mail" })).toEqual({ primary: "Mail", secondary: "com.apple.mail" });
  });

  it("falls back to the bundle id alone when the app can't be found on this Mac", () => {
    expect(L.appRowLabel("com.acme.gone", { name: null })).toEqual({ primary: "com.acme.gone", secondary: null });
    expect(L.appRowLabel("com.acme.gone", undefined)).toEqual({ primary: "com.acme.gone", secondary: null });
  });
});
