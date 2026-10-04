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

describe("sanitizePrefsPatch — reply suggestions fields", () => {
  it("keeps valid reply fields", () => {
    const patch = {
      replySuggestionsEnabled: true,
      userDisplayName: "Danilo Franco",
      replySuggestionsHotkey: "Command+Control+R",
      replyModelId: "gemma-4-e4b",
      replyAppsMode: "blocklist",
      replyApps: ["com.apple.mail", "com.tinyspeck.slackmacgap"],
    };
    expect(sanitizePrefsPatch(patch)).toEqual(patch);
  });

  it("trims the display name and drops a non-string one", () => {
    expect(sanitizePrefsPatch({ userDisplayName: "  Danilo  " })).toEqual({ userDisplayName: "Danilo" });
    expect(sanitizePrefsPatch({ userDisplayName: 4 })).toEqual({});
    expect(sanitizePrefsPatch({ userDisplayName: "x".repeat(500) }).userDisplayName).toHaveLength(100);
  });

  it("drops a hotkey the reply validator rejects (Option, no modifier, reserved key)", () => {
    expect(sanitizePrefsPatch({ replySuggestionsHotkey: "Alt+R" })).toEqual({});
    expect(sanitizePrefsPatch({ replySuggestionsHotkey: "R" })).toEqual({});
    expect(sanitizePrefsPatch({ replySuggestionsHotkey: "Command+1" })).toEqual({});
    expect(sanitizePrefsPatch({ replySuggestionsHotkey: "Command+Shift+K" })).toEqual({
      replySuggestionsHotkey: "Command+Shift+K",
    });
  });

  it("drops a reply model id that is not in the reply catalog (a Qwen id included)", () => {
    expect(sanitizePrefsPatch({ replyModelId: "qwen-3b" })).toEqual({});
    expect(sanitizePrefsPatch({ replyModelId: "gemma-3-4b" })).toEqual({ replyModelId: "gemma-3-4b" });
  });

  it("only accepts the two apps modes", () => {
    expect(sanitizePrefsPatch({ replyAppsMode: "everything" })).toEqual({});
    expect(sanitizePrefsPatch({ replyAppsMode: "allowlist" })).toEqual({ replyAppsMode: "allowlist" });
  });

  it("trims and de-duplicates app bundle ids and drops entries that are not bundle ids", () => {
    expect(
      sanitizePrefsPatch({ replyApps: [" com.apple.mail ", "COM.APPLE.MAIL", "", "not a bundle id", "com.brave.Browser"] }),
    ).toEqual({ replyApps: ["com.apple.mail", "com.brave.Browser"] });
    expect(sanitizePrefsPatch({ replyApps: ["com.apple.mail", 3] })).toEqual({});
    expect(sanitizePrefsPatch({ replyApps: "com.apple.mail" })).toEqual({});
  });

  it("drops a non-boolean enabled flag", () => {
    expect(sanitizePrefsPatch({ replySuggestionsEnabled: "true" })).toEqual({});
  });
});
