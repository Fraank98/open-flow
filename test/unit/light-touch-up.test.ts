import { describe, it, expect } from "vitest";
import { lightTouchUp } from "../../src/main/utils/light-touch-up.js";

describe("lightTouchUp", () => {
  it("capitalizes the first letter", () => {
    expect(lightTouchUp("hello world.")).toBe("Hello world.");
  });

  it("adds a trailing period when missing", () => {
    expect(lightTouchUp("hello")).toBe("Hello.");
  });

  it("preserves existing terminal punctuation", () => {
    expect(lightTouchUp("hello!")).toBe("Hello!");
    expect(lightTouchUp("hello?")).toBe("Hello?");
    expect(lightTouchUp("hello…")).toBe("Hello…");
  });

  it("returns empty for whitespace-only input", () => {
    expect(lightTouchUp("   ")).toBe("");
    expect(lightTouchUp("")).toBe("");
  });
});
