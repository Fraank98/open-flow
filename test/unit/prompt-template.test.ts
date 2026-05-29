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

  it("includes the universal verbal fillers (rule A), incl. ähm/euh", () => {
    const p = buildCleanupPrompt("test", "it");
    for (const f of ["uh", "um", "ehm", "uhm", "ähm", "euh"]) {
      expect(p).toContain(f);
    }
  });

  it("shows only the targeted language's rule-B list when languageHint is known", () => {
    // Italian hint → only the Italian section header must appear.
    // (Checking section labels — words like "also"/"well" can innocently
    // appear in the rules text itself.)
    const p = buildCleanupPrompt("test", "it");
    expect(p).toContain("Italian:"); // section header present
    expect(p).toContain("allora"); // Italian list present
    expect(p).not.toContain("English:"); // other section headers absent
    expect(p).not.toContain("German:");
    expect(p).not.toContain("French:");
    expect(p).not.toContain("Spanish:");
  });

  it("shows the English rule-B list when languageHint='en'", () => {
    const p = buildCleanupPrompt("test", "en");
    for (const f of ["well", "so", "like", "basically", "you know", "I mean"]) {
      expect(p).toContain(f);
    }
    expect(p).toContain("English");
    expect(p).not.toContain("allora");
  });

  it("shows the German rule-B list when languageHint='de'", () => {
    const p = buildCleanupPrompt("test", "de");
    for (const f of ["also", "halt", "naja"]) {
      expect(p).toContain(f);
    }
    expect(p).toContain("German");
    expect(p).not.toContain("allora");
  });

  it("shows the French rule-B list when languageHint='fr'", () => {
    const p = buildCleanupPrompt("test", "fr");
    for (const f of ["alors", "bah", "ben", "voilà", "en fait", "tu sais"]) {
      expect(p).toContain(f);
    }
    expect(p).toContain("French");
    expect(p).not.toContain("allora");
  });

  it("shows the Spanish rule-B list when languageHint='es'", () => {
    const p = buildCleanupPrompt("test", "es");
    for (const f of ["pues", "bueno", "o sea", "vale", "digamos"]) {
      expect(p).toContain(f);
    }
    expect(p).toContain("Spanish");
    expect(p).not.toContain("allora");
  });

  it("shows ALL language lists when languageHint='auto'", () => {
    const p = buildCleanupPrompt("test", "auto");
    // One representative word per language must be present.
    for (const f of ["allora", "well", "also", "alors", "pues"]) {
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
