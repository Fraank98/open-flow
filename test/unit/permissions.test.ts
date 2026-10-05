import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetElectronMock, systemPreferences } from "../helpers/electron-mock.js";

vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);

import {
  checkMicrophone,
  checkAutomationViaProbe,
  checkAccessibility,
  requestAccessibility,
  permissionsReady,
} from "../../src/main/permissions.js";

// Renamed from the old Accessibility-named probe: that osascript probe measures the
// Automation (Apple Events) permission, not Accessibility. Same logic, honest name.
describe("checkAutomationViaProbe timeout", () => {
  it("returns 'unknown' when the probe never answers (unanswered TCC prompt)", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>(() => undefined));
      const pending = checkAutomationViaProbe(exec, 15_000);
      let settled: string | null = null;
      void pending.then((r) => {
        settled = r;
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the probe answers in time", async () => {
    vi.useFakeTimers();
    try {
      const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
      expect(await checkAutomationViaProbe(exec, 15_000)).toBe("granted");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

describe("checkMicrophone", () => {
  beforeEach(() => resetElectronMock());

  it("asks the OS about the microphone and maps 'granted'", async () => {
    systemPreferences.getMediaAccessStatus.mockReturnValue("granted");
    expect(await checkMicrophone()).toBe("granted");
    expect(systemPreferences.getMediaAccessStatus).toHaveBeenCalledWith("microphone");
  });

  it.each(["denied", "restricted"])("maps '%s' to denied", async (status) => {
    systemPreferences.getMediaAccessStatus.mockReturnValue(status);
    expect(await checkMicrophone()).toBe("denied");
  });

  it.each(["not-determined", "unknown", ""])("maps '%s' to unknown", async (status) => {
    systemPreferences.getMediaAccessStatus.mockReturnValue(status);
    expect(await checkMicrophone()).toBe("unknown");
  });
});

describe("checkAutomationViaProbe denied-message variants", () => {
  it.each([
    ["accessibility", "osascript needs Accessibility access"],
    ["not allowed", "Operation NOT ALLOWED"],
    ["not authorized", "Not Authorized to send Apple events"],
  ])("returns 'denied' for a '%s' message", async (_label, message) => {
    expect(await checkAutomationViaProbe(async () => { throw new Error(message); })).toBe("denied");
  });

  it("handles a non-Error rejection: matches on its string form", async () => {
    expect(await checkAutomationViaProbe(async () => { throw "not authorized (string)"; })).toBe("denied");
    expect(await checkAutomationViaProbe(async () => { throw "kaboom"; })).toBe("unknown");
  });

  it("sends the System Events probe command through osascript", async () => {
    const exec = vi.fn(async (_cmd: string) => ({ stdout: "", stderr: "" }));
    await checkAutomationViaProbe(exec);
    expect(exec.mock.calls[0]![0]).toContain("osascript");
    expect(exec.mock.calls[0]![0]).toContain("System Events");
  });
});
