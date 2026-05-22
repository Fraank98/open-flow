import { describe, it, expect } from "vitest";
import { applySpokenPunctuation } from "../../src/main/utils/spoken-punctuation.js";

describe("applySpokenPunctuation", () => {
  it("returns text unchanged when no punctuation words are present", () => {
    expect(applySpokenPunctuation("hello world", "en")).toBe("hello world");
    expect(applySpokenPunctuation("ciao come stai", "it")).toBe("ciao come stai");
  });

  it("replaces English punctuation words", () => {
    expect(applySpokenPunctuation("hello comma world period", "en")).toBe("hello, world.");
    expect(applySpokenPunctuation("are you sure question mark", "en")).toBe("are you sure?");
    expect(applySpokenPunctuation("watch out exclamation mark", "en")).toBe("watch out!");
    expect(applySpokenPunctuation("a colon b semicolon c", "en")).toBe("a: b; c");
  });

  it("replaces Italian punctuation words", () => {
    expect(applySpokenPunctuation("ciao virgola come stai punto", "it")).toBe("ciao, come stai.");
    expect(applySpokenPunctuation("sei sicuro punto interrogativo", "it")).toBe("sei sicuro?");
    expect(applySpokenPunctuation("ottimo punto esclamativo", "it")).toBe("ottimo!");
    expect(applySpokenPunctuation("a due punti b punto e virgola c", "it")).toBe("a: b; c");
  });

  it("handles multi-word commands before single-word ones", () => {
    // "punto e virgola" must beat "punto" + "virgola"
    expect(applySpokenPunctuation("a punto e virgola b", "it")).toBe("a; b");
    // "punto interrogativo" must beat "punto"
    expect(applySpokenPunctuation("davvero punto interrogativo", "it")).toBe("davvero?");
  });

  it("handles paragraph and newline commands", () => {
    expect(applySpokenPunctuation("primo paragrafo nuovo paragrafo secondo", "it"))
      .toBe("primo paragrafo\n\nsecondo");
    expect(applySpokenPunctuation("riga uno a capo riga due", "it"))
      .toBe("riga uno\nriga due");
    expect(applySpokenPunctuation("line one new line line two", "en"))
      .toBe("line one\nline two");
  });

  it("falls back to en+it rules when language is auto", () => {
    // English command parsed under auto
    expect(applySpokenPunctuation("hello comma world", "auto")).toBe("hello, world");
    // Italian command parsed under auto
    expect(applySpokenPunctuation("ciao virgola mondo", "auto")).toBe("ciao, mondo");
  });

  it("is case-insensitive", () => {
    expect(applySpokenPunctuation("Hello COMMA world Period", "en")).toBe("Hello, world.");
    expect(applySpokenPunctuation("Ciao VIRGOLA come stai PUNTO", "it")).toBe("Ciao, come stai.");
  });

  it("returns unchanged text when language has no rules", () => {
    expect(applySpokenPunctuation("hello comma world", "xx")).toBe("hello comma world");
  });
});
