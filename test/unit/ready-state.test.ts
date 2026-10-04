import { describe, it, expect } from "vitest";
import { readyStateForArmer } from "../../src/main/utils/ready-state.js";

describe("readyStateForArmer", () => {
  it("is ready once push-to-talk is armed, with or without a late grant", () => {
    expect(readyStateForArmer("armed")).toBe("ready");
    expect(readyStateForArmer("armed-after-grant")).toBe("ready");
  });

  it("reports the blocked states", () => {
    expect(readyStateForArmer("waiting")).toBe("accessibility-off");
    expect(readyStateForArmer("relaunch-needed")).toBe("relaunch-needed");
  });
});
