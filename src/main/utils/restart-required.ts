import type { Preferences } from "../preferences-store.js";

// Fields that the running main process cannot pick up without a relaunch:
// the Whisper / LLM models are loaded into their servers at boot, and the
// llama-server is only started at launch when LLM cleanup is enabled.
// Everything else (language, dictionary, debug logging, launch-at-login,
// spoken punctuation) is applied live.
export const RESTART_REQUIRED_FIELDS = ["whisperModelId", "llmModelId", "useLlmCleanup"] as const;

/**
 * Which restart-required fields differ between the prefs the app booted with
 * and the saved ones. Comparing against the boot snapshot (not the previous
 * save) means the list empties by itself when the user reverts a change.
 */
export function restartRequiredFields(boot: Preferences, current: Preferences): string[] {
  return RESTART_REQUIRED_FIELDS.filter((k) => boot[k] !== current[k]);
}
