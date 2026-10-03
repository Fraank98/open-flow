import { describe, it, expect, vi } from "vitest";
import {
  checkAutomationViaProbe,
  checkAccessibility,
  requestAccessibility,
  permissionsReady,
} from "../../src/main/permissions.js";

// Renamed from the old Accessibility-named probe: that osascript probe measures the
// Automation (Apple Events) permission, not Accessibility. Same logic, honest name.
describe("checkAutomationViaProbe", () => {
  it("returns 'granted' when probe command succeeds", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const result = await checkAutomationViaProbe(exec);
    expect(result).toBe("granted");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns 'denied' when probe rejects with accessibility error", async () => {
    const exec = vi.fn(async () => {
      const err: NodeJS.ErrnoException = new Error("not authorized to send keystrokes");
      throw err;
    });
    const result = await checkAutomationViaProbe(exec);
    expect(result).toBe("denied");
  });

  it("returns 'denied' on the System Events Apple Events error (-1743)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("Not authorized to send Apple events to System Events. (-1743)");
    });
    expect(await checkAutomationViaProbe(exec)).toBe("denied");
  });

  it("returns 'unknown' on unrelated exec failure", async () => {
    const exec = vi.fn(async () => {
      throw new Error("some other error");
    });
    const result = await checkAutomationViaProbe(exec);
    expect(result).toBe("unknown");
  });
});

describe("checkAccessibility", () => {
  it("is granted when the AX API trusts the process", () => {
    expect(checkAccessibility({ isTrusted: () => true })).toBe("granted");
  });
  it("is denied otherwise", () => {
    expect(checkAccessibility({ isTrusted: () => false })).toBe("denied");
  });
});

describe("requestAccessibility", () => {
  it("calls requestTrust exactly once and returns the resulting status", () => {
    const requestTrust = vi.fn(() => false);
    const isTrusted = vi.fn(() => false);
    expect(requestAccessibility({ isTrusted, requestTrust })).toBe("denied");
    expect(requestTrust).toHaveBeenCalledTimes(1);

    const granted = { isTrusted: () => true, requestTrust: vi.fn(() => true) };
    expect(requestAccessibility(granted)).toBe("granted");
    expect(granted.requestTrust).toHaveBeenCalledTimes(1);
  });
});

describe("permissionsReady", () => {
  it("is true only when mic, accessibility and automation are all granted", () => {
    expect(permissionsReady({ mic: "granted", accessibility: "granted", automation: "granted" })).toBe(true);
    expect(permissionsReady({ mic: "granted", accessibility: "granted", automation: "unknown" })).toBe(false);
    expect(permissionsReady({ mic: "denied", accessibility: "granted", automation: "granted" })).toBe(false);
    expect(permissionsReady({ mic: "granted", accessibility: "denied", automation: "granted" })).toBe(false);
  });
});
