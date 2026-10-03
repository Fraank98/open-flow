import { describe, it, expect } from "vitest";
import { sanitizePrefsPatch } from "../../src/main/utils/prefs-patch.js";

describe("sanitizePrefsPatch", () => {
  it("keeps the settable fields with the right type", () => {
    const patch = {
      language: "it",
      debugLogging: true,
      useLlmCleanup: false,
      launchAtLogin: false,
      spokenPunctuation: true,
      dictionary: ["Kubernetes", "open-flow"],
      whisperModelId: "whisper-small",
      llmModelId: "qwen-3b",
    };
    expect(sanitizePrefsPatch(patch)).toEqual(patch);
  });

  it("drops unknown fields and fields that Settings must not write", () => {
    expect(
      sanitizePrefsPatch({ setupComplete: false, setupStep: "welcome", hotkeyAccelerator: "x", foo: 1, language: "en" }),
    ).toEqual({ language: "en" });
  });

  it("drops values of the wrong type", () => {
    expect(sanitizePrefsPatch({ debugLogging: "yes", language: 3, dictionary: "a", useLlmCleanup: null })).toEqual({});
    expect(sanitizePrefsPatch({ dictionary: ["ok", 4] })).toEqual({});
  });

  it("drops a language that is not in the supported list", () => {
    expect(sanitizePrefsPatch({ language: "xx" })).toEqual({});
    expect(sanitizePrefsPatch({ language: "" })).toEqual({});
    for (const id of ["auto", "en", "it", "es", "fr", "de"]) {
      expect(sanitizePrefsPatch({ language: id })).toEqual({ language: id });
    }
  });

  it("drops model ids that are not in the catalog", () => {
    expect(sanitizePrefsPatch({ whisperModelId: "nope", llmModelId: "qwen-1.5b" })).toEqual({ llmModelId: "qwen-1.5b" });
  });

  it("trims and de-duplicates dictionary terms", () => {
    expect(sanitizePrefsPatch({ dictionary: [" Kubernetes ", "", "kubernetes", "Rust"] })).toEqual({
      dictionary: ["Kubernetes", "Rust"],
    });
  });

  it("returns {} for a non-object", () => {
    expect(sanitizePrefsPatch(null)).toEqual({});
    expect(sanitizePrefsPatch("x")).toEqual({});
  });
});
