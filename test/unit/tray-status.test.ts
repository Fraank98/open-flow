import { describe, it, expect } from "vitest";
import { trayStateForArmer } from "../../src/main/utils/tray-status.js";
import type { PttArmState } from "../../src/main/utils/ptt-arming.js";

describe("trayStateForArmer", () => {
  it("armed: ready status, hint cleared, and it becomes the status to restore", () => {
    expect(trayStateForArmer("armed")).toEqual({
      status: "Ready — hold ⌥ to dictate",
      hint: null,
      readyStatus: "Ready — hold ⌥ to dictate",
    });
  });

  it("armed-after-grant: warns that Option may need a relaunch, and it is the status to restore", () => {
    const s = trayStateForArmer("armed-after-grant");
    expect(s.status).toBe("Ready — if Option doesn't respond, choose Relaunch open-flow");
    expect(s.hint).toBeNull();
    expect(s.readyStatus).toBe(s.status);
  });

  it("waiting: asks for Accessibility with a hint, and is not a ready status", () => {
    const s = trayStateForArmer("waiting");
    expect(s.status).toBe("Needs Accessibility permission");
    expect(s.hint).toBe("Open System Settings › Privacy & Security › Accessibility and turn on open-flow");
    expect(s.readyStatus).toBeUndefined();
  });

  it("relaunch-needed: asks for a relaunch, no hint, not a ready status", () => {
    const s = trayStateForArmer("relaunch-needed");
    expect(s).toEqual({ status: "Permission granted — relaunch to activate", hint: null });
    expect("readyStatus" in s).toBe(false);
  });

  it("readyStatus is set for exactly the two armed states", () => {
    const states: PttArmState[] = ["armed", "waiting", "armed-after-grant", "relaunch-needed"];
    expect(states.filter((s) => trayStateForArmer(s).readyStatus !== undefined)).toEqual(["armed", "armed-after-grant"]);
  });
});
