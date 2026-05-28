import { describe, it, expect } from "vitest";
import { buildCleanupPrompt } from "../../src/main/utils/prompt-template.js";

describe("buildCleanupPrompt (disfluency-only)", () => {
  it("frames the task as disfluency removal, not punctuation", () => {
    const p = buildCleanupPrompt("test", "it");
    expect(p).toMatch(/remove disfluencies/i);
    // The old "Add punctuation" framing must be gone.
    expect(p).not.toMatch(/Add punctuation and capitalization/i);
  });

  it("includes the Italian discourse-marker filler list (rule B)", () => {
    const p = buildCleanupPrompt("test", "it");
    for (const f of ["allora", "cioè", "diciamo", "praticamente", "insomma", "tipo", "ecco"]) {
      expect(p).toContain(f);
    }
  });

  it("includes the universal verbal fillers (rule A)", () => {
    const p = buildCleanupPrompt("test", "it");
    for (const f of ["uh", "um", "ehm", "uhm"]) {
      expect(p).toContain(f);
    }
  });

  it("documents the only allowed punctuation exception (capitalize after sentence-initial filler)", () => {
    const p = buildCleanupPrompt("test", "it");
    expect(p).toMatch(/sentence-initial filler/i);
    expect(p).toMatch(/capitalize/i);
  });

  it("wraps the raw transcript verbatim between the transcript delimiters", () => {
    const p = buildCleanupPrompt("HELLO world", "it");
    expect(p).toContain("<<<transcript>>>\nHELLO world\n<<</transcript>>>");
    expect(p.trim().endsWith("Cleaned:")).toBe(true);
  });

  it("appends a language hint when given a non-auto language", () => {
    const p = buildCleanupPrompt("ciao", "it");
    expect(p).toContain("Italian");
  });

  it("omits the language hint when language is 'auto'", () => {
    const p = buildCleanupPrompt("hello", "auto");
    expect(p).not.toMatch(/The input is in /);
  });
});
