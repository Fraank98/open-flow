import { describe, it, expect } from "vitest";
import { buildInitialPrompt } from "../../src/main/utils/initial-prompt.js";

describe("buildInitialPrompt", () => {
  it("returns an empty prompt and no dropped terms for an empty dictionary", () => {
    expect(buildInitialPrompt([])).toEqual({ prompt: "", dropped: [] });
    expect(buildInitialPrompt(["  "])).toEqual({ prompt: "", dropped: [] });
  });

  it("joins terms into a comma-separated vocabulary hint", () => {
    expect(buildInitialPrompt(["Slack", "Wispr Flow"])).toEqual({
      prompt: "Slack, Wispr Flow",
      dropped: [],
    });
  });

  it("caps to maxChars and reports dropped terms", () => {
    const terms = ["aaaa", "bbbb", "cccc"];
    // maxChars small enough that only the first two fit ("aaaa, bbbb" = 10)
    const { prompt, dropped } = buildInitialPrompt(terms, { maxChars: 10 });
    expect(prompt).toBe("aaaa, bbbb");
    expect(dropped).toEqual(["cccc"]);
  });
});
