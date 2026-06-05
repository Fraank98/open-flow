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
    // "Wispr Flow" must win even when a shorter, differently-cased "FLOW" term
    // is also present — the shorter term must not mutate the longer's output.
    expect(applyDictionary("uso wispr flow", ["FLOW", "Wispr Flow"]))
      .toBe("uso Wispr Flow");
  });

  it("handles terms containing regex-special characters", () => {
    expect(applyDictionary("uso c++ ogni giorno", ["C++"])).toBe("uso C++ ogni giorno");
    expect(applyDictionary("apri node.js", ["Node.js"])).toBe("apri Node.js");
  });

  it("inserts the canonical spelling literally (no $-pattern expansion)", () => {
    // Regression for Bug 1: a term with a $-sequence must be inserted verbatim.
    expect(applyDictionary("x a$&b y", ["a$&b"])).toBe("x a$&b y");
  });
});
