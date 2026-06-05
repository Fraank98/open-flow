import { describe, it, expect } from "vitest";
import { applyDictionary } from "../../src/main/utils/dictionary.js";

describe("applyDictionary — exact & multi-word", () => {
  it("returns text unchanged when the dictionary is empty", () => {
    expect(applyDictionary("ho usato slack oggi", [])).toBe("ho usato slack oggi");
    expect(applyDictionary("ho usato slack oggi", ["   "])).toBe("ho usato slack oggi");
  });

  it("normalizes spelling on a case-insensitive exact match", () => {
    expect(applyDictionary("ho usato slack oggi", ["Slack"])).toBe("ho usato Slack oggi");
    expect(applyDictionary("SLACK rocks", ["Slack"])).toBe("Slack rocks");
  });

  it("matches on Unicode word boundaries and preserves adjacent punctuation", () => {
    expect(applyDictionary("uso slack, ogni giorno", ["Slack"])).toBe("uso Slack, ogni giorno");
    expect(applyDictionary("(slack)", ["Slack"])).toBe("(Slack)");
  });

  it("does not match inside a larger word", () => {
    expect(applyDictionary("slacker", ["Slack"])).toBe("slacker");
  });

  it("corrects multi-word terms with flexible whitespace", () => {
    expect(applyDictionary("apri wispr flow adesso", ["Wispr Flow"]))
      .toBe("apri Wispr Flow adesso");
    expect(applyDictionary("wispr   flow", ["Wispr Flow"])).toBe("Wispr Flow");
  });

  it("applies longer terms before shorter overlapping ones", () => {
    // "Wispr Flow" must win over a bare "Flow" term
    expect(applyDictionary("uso wispr flow", ["Flow", "Wispr Flow"]))
      .toBe("uso Wispr Flow");
  });
});
