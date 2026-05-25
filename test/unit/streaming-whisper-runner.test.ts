import { describe, it, expect } from "vitest";
import { computeNewSuffix } from "../../src/main/streaming-whisper-runner.js";

describe("computeNewSuffix", () => {
  it("returns the full current when committed is empty", () => {
    expect(computeNewSuffix("", "hello world")).toBe("hello world");
  });

  it("returns empty when current is identical to committed", () => {
    expect(computeNewSuffix("hello world", "hello world")).toBe("");
  });

  it("returns only the words appended in current", () => {
    expect(computeNewSuffix("hello world", "hello world today")).toBe("today");
    expect(computeNewSuffix("ciao", "ciao come stai")).toBe("come stai");
  });

  it("matches case-insensitively on token prefix", () => {
    expect(computeNewSuffix("Hello World", "hello world today")).toBe("today");
  });

  it("collapses multiple whitespace between tokens", () => {
    expect(computeNewSuffix("hello   world", "hello world today")).toBe("today");
  });

  it("treats a diverged word as the start of the new suffix", () => {
    // Whisper changes its mind on word 2 — everything from there is the new tail.
    expect(computeNewSuffix("hello world", "hello mondo today")).toBe("mondo today");
  });

  it("returns trimmed empty string when current is whitespace", () => {
    expect(computeNewSuffix("hello world", "   ")).toBe("");
  });
});
