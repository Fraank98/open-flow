import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/setup-logic.js";

interface SetupLogic {
  permissionBadge(status: string | undefined): { text: string; cls: string };
  canContinuePermissions(state: Record<string, string>): boolean;
}
const L = (globalThis as unknown as { OpenFlowSetupLogic: SetupLogic }).OpenFlowSetupLogic;

describe("permissionBadge", () => {
  it("maps statuses to text and css class", () => {
    expect(L.permissionBadge("granted")).toEqual({ text: "Granted", cls: "granted" });
    expect(L.permissionBadge("denied")).toEqual({ text: "Denied — fix in System Settings", cls: "denied" });
    expect(L.permissionBadge("unknown")).toEqual({ text: "Not asked yet", cls: "pending" });
    expect(L.permissionBadge(undefined)).toEqual({ text: "Not asked yet", cls: "pending" });
  });
});

describe("canContinuePermissions", () => {
  const ok = { micPermission: "granted", accessibilityPermission: "granted", automationPermission: "granted" };
  it("requires all three permissions (Automation is mandatory)", () => {
    expect(L.canContinuePermissions(ok)).toBe(true);
    expect(L.canContinuePermissions({ ...ok, automationPermission: "unknown" })).toBe(false);
    expect(L.canContinuePermissions({ ...ok, accessibilityPermission: "denied" })).toBe(false);
    expect(L.canContinuePermissions({ ...ok, micPermission: "unknown" })).toBe(false);
    expect(L.canContinuePermissions({})).toBe(false);
  });
});
