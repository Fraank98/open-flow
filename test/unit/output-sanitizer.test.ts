import { describe, it, expect } from "vitest";
import { sanitizeLlmOutput } from "../../src/main/utils/output-sanitizer.js";

describe("sanitizeLlmOutput", () => {
  it("returns cleaned output when reasonable", () => {
    const result = sanitizeLlmOutput("Hello world.", "hello world");
    expect(result.text).toBe("Hello world.");
    expect(result.usedFallback).toBe(false);
  });

  it("strips common noisy prefixes", () => {
    const inputs = [
      "Here is the cleaned text: Hello.",
      "Cleaned: Hello.",
      "Cleaned text:\nHello.",
      "Sure, here is the cleaned version:\nHello.",
    ];
    for (const i of inputs) {
      const result = sanitizeLlmOutput(i, "hello");
      expect(result.text).toBe("Hello.");
    }
  });

  it("trims surrounding quotes when LLM wraps output", () => {
    expect(sanitizeLlmOutput('"Hello."', "hello").text).toBe("Hello.");
    expect(sanitizeLlmOutput("'Hello.'", "hello").text).toBe("Hello.");
  });

  it("falls back to raw if output is empty", () => {
    const result = sanitizeLlmOutput("   ", "raw transcript here");
    expect(result.text).toBe("raw transcript here");
    expect(result.usedFallback).toBe(true);
  });

  it("falls back to raw if output is over 3x the raw length", () => {
    const raw = "hello world";
    const inflated = "Hello world. ".repeat(20);
    const result = sanitizeLlmOutput(inflated, raw);
    expect(result.text).toBe(raw);
    expect(result.usedFallback).toBe(true);
  });

  it("does not fall back for short outputs even if proportionally large", () => {
    // raw is very short, output is small absolute size — fine
    const result = sanitizeLlmOutput("Hi.", "hi");
    expect(result.usedFallback).toBe(false);
  });
});
