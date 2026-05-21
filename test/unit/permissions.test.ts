import { describe, it, expect, vi } from "vitest";
import { checkAccessibilityViaProbe } from "../../src/main/permissions.js";

describe("checkAccessibilityViaProbe", () => {
  it("returns 'granted' when probe command succeeds", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("granted");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("returns 'denied' when probe rejects with accessibility error", async () => {
    const exec = vi.fn(async () => {
      const err: NodeJS.ErrnoException = new Error("not authorized to send keystrokes");
      throw err;
    });
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("denied");
  });

  it("returns 'unknown' on unrelated exec failure", async () => {
    const exec = vi.fn(async () => {
      throw new Error("some other error");
    });
    const result = await checkAccessibilityViaProbe(exec);
    expect(result).toBe("unknown");
  });
});
