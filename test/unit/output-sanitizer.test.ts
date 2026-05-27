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

  it("does not strip the word 'sure' when it's legitimate user content", () => {
    // Bare "Sure," at the start of a real transcript should be preserved
    expect(sanitizeLlmOutput("Sure, I can help with that.", "sure i can help with that").text)
      .toBe("Sure, I can help with that.");
    expect(sanitizeLlmOutput("Sure! That works.", "sure that works").text)
      .toBe("Sure! That works.");
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

  it("does not strip 'sure' followed by keywords when no colon preamble structure exists", () => {
    expect(sanitizeLlmOutput("Sure, cleaned my room today.", "sure cleaned my room today").text)
      .toBe("Sure, cleaned my room today.");
    expect(sanitizeLlmOutput("Sure, corrected the report yesterday.", "sure corrected the report yesterday").text)
      .toBe("Sure, corrected the report yesterday.");
    expect(sanitizeLlmOutput("Sure here's the deal.", "sure here is the deal").text)
      .toBe("Sure here's the deal.");
    expect(sanitizeLlmOutput("Sure here is my answer.", "sure here is my answer").text)
      .toBe("Sure here is my answer.");
  });

  it("does not strip standalone 'Cleaned' followed by content without colon", () => {
    // "Cleaned the dishes" should not be stripped (no colon = no preamble structure)
    expect(sanitizeLlmOutput("Cleaned the dishes earlier.", "cleaned the dishes earlier").text)
      .toBe("Cleaned the dishes earlier.");
  });

  it("strips markdown emphasis markers the model adds despite instructions", () => {
    // Qwen 1.5B routinely bolds/italicizes words even though the prompt forbids
    // markdown. The words are correct — only the * markers must go.
    const raw = "no lo scroll automatico non funziona ancora";
    const out = "**No**, **lo** *scroll automatico* non funziona ancora.";
    const result = sanitizeLlmOutput(out, raw);
    expect(result.text).toBe("No, lo scroll automatico non funziona ancora.");
    expect(result.usedFallback).toBe(false);
  });

  it("removes unbalanced markdown asterisks", () => {
    expect(sanitizeLlmOutput("Vedo tutto **fermo***.*", "vedo tutto fermo").text)
      .toBe("Vedo tutto fermo.");
  });
});
