import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/settings-logic.js";

interface ReplyLogic {
  replyGuardMessage(input: { name: string; modelInstalled: boolean; tierLabel: string; nativeOk: boolean }): string;
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
