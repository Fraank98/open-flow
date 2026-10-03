import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/settings-logic.js";

interface ReplyLogic {
  replyGuardMessage(input: { name: string; modelInstalled: boolean; tierLabel: string; nativeOk: boolean }): string;
  acceleratorLabel(accelerator: string): string;
  replyStatusView(
    status: { serverState: string; hotkeyRegistered: boolean; nativeOk: boolean },
    accelerator: string,
  ): { text: string; tone: "ok" | "busy" | "error" | "none"; action: "retry" | null };
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
