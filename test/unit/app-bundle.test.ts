import { describe, it, expect, vi } from "vitest";
import {
  appNameFromPath,
  findAppPathByBundleId,
  isBundleId,
  mapWithLimit,
  readBundleId,
  type ExecFn,
} from "../../src/main/utils/app-bundle.js";

const APP = "/Applications/Mail.app";

describe("readBundleId", () => {
  it("reads the identifier with mdls first", async () => {
    const exec = vi.fn<ExecFn>(async () => "com.apple.mail\n");
    expect(await readBundleId(APP, exec)).toBe("com.apple.mail");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("mdls", ["-name", "kMDItemCFBundleIdentifier", "-raw", APP]);
  });

  it("falls back to plutil when mdls has no value (Spotlight not indexing the app)", async () => {
    const exec = vi.fn<ExecFn>(async (file) => (file === "mdls" ? "(null)\n" : "com.brave.Browser\n"));
    expect(await readBundleId("/Applications/Brave Browser.app", exec)).toBe("com.brave.Browser");
    expect(exec).toHaveBeenLastCalledWith("plutil", [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "/Applications/Brave Browser.app/Contents/Info.plist",
    ]);
  });

  it("falls back to plutil when mdls fails, and returns null when both fail", async () => {
    const mdlsFails = vi.fn<ExecFn>(async (file) => {
      if (file === "mdls") throw new Error("boom");
      return "com.x.y";
    });
    expect(await readBundleId(APP, mdlsFails)).toBe("com.x.y");
    const allFail = vi.fn<ExecFn>(async () => {
      throw new Error("boom");
    });
    expect(await readBundleId(APP, allFail)).toBeNull();
  });

  it("rejects an output that is not a bundle id", async () => {
    const exec = vi.fn<ExecFn>(async () => "not a bundle id\n");
    expect(await readBundleId(APP, exec)).toBeNull();
  });
});

describe("findAppPathByBundleId", () => {
  it("asks Spotlight for the app and returns the first .app path", async () => {
    const exec = vi.fn<ExecFn>(async () => "/Users/me/Library/foo.plugin\n/Applications/Mail.app\n");
    expect(await findAppPathByBundleId("com.apple.mail", exec, "/Users/me")).toBe("/Applications/Mail.app");
    expect(exec).toHaveBeenCalledWith("mdfind", [
      "-onlyin", "/Applications",
      "-onlyin", "/Users/me/Applications",
      "-onlyin", "/System/Applications",
      "kMDItemCFBundleIdentifier == 'com.apple.mail'",
    ]);
  });

  it("returns null when nothing is found or the lookup fails", async () => {
    expect(await findAppPathByBundleId("com.x.y", async () => "")).toBeNull();
    expect(
      await findAppPathByBundleId("com.x.y", async () => {
        throw new Error("boom");
      }),
    ).toBeNull();
  });

  it("never builds a query from something that is not a bundle id", async () => {
    const exec = vi.fn<ExecFn>(async () => "");
    expect(await findAppPathByBundleId("x' || kMDItemKind == '*", exec)).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("mapWithLimit", () => {
  it("keeps the order of the results and never runs more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(peak).toBe(4);
  });

  it("handles an empty list", async () => {
    expect(await mapWithLimit([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("appNameFromPath / isBundleId", () => {
  it("uses the bundle folder name without .app", () => {
    expect(appNameFromPath("/Applications/Google Chrome.app")).toBe("Google Chrome");
    expect(appNameFromPath("/Applications/Slack.app/")).toBe("Slack");
  });

  it("recognises reverse-DNS bundle ids only", () => {
    expect(isBundleId("com.tinyspeck.slackmacgap")).toBe(true);
    expect(isBundleId("com.apple.mail ")).toBe(false);
    expect(isBundleId("")).toBe(false);
    expect(isBundleId("a/b")).toBe(false);
  });
});
