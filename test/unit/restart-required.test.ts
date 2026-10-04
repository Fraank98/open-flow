import { describe, it, expect } from "vitest";
import { RESTART_REQUIRED_FIELDS, restartRequiredFields } from "../../src/main/utils/restart-required.js";
import { DEFAULT_PREFS } from "../../src/main/preferences-store.js";

describe("restart-required", () => {
  it("lists exactly the fields that need a relaunch", () => {
    expect([...RESTART_REQUIRED_FIELDS]).toEqual(["whisperModelId", "llmModelId", "useLlmCleanup"]);
  });

  it("returns [] when nothing changed", () => {
    expect(restartRequiredFields(DEFAULT_PREFS, { ...DEFAULT_PREFS })).toEqual([]);
  });

  it("returns only the changed restart-required field", () => {
    expect(restartRequiredFields(DEFAULT_PREFS, { ...DEFAULT_PREFS, llmModelId: "qwen-3b" })).toEqual(["llmModelId"]);
  });

  it("ignores fields that apply live (language, debug logging, dictionary)", () => {
    const next = { ...DEFAULT_PREFS, language: "it", debugLogging: true, dictionary: ["x"] };
    expect(restartRequiredFields(DEFAULT_PREFS, next)).toEqual([]);
  });

  it("goes back to [] when the value returns to the boot value", () => {
    const changed = { ...DEFAULT_PREFS, useLlmCleanup: false };
    expect(restartRequiredFields(DEFAULT_PREFS, changed)).toEqual(["useLlmCleanup"]);
    expect(restartRequiredFields(DEFAULT_PREFS, { ...changed, useLlmCleanup: true })).toEqual([]);
  });
});
