import { getModelById } from "../model-catalog.js";
import { isSupportedLanguage } from "./languages.js";
import type { Preferences } from "../preferences-store.js";

/** Fields the Settings window may write. Everything else (setup state, hotkey) is main-owned. */
export type SettingsPatch = Partial<
  Pick<
    Preferences,
    | "language"
    | "debugLogging"
    | "useLlmCleanup"
    | "launchAtLogin"
    | "spokenPunctuation"
    | "dictionary"
    | "whisperModelId"
    | "llmModelId"
  >
>;

const BOOLEAN_FIELDS = ["debugLogging", "useLlmCleanup", "launchAtLogin", "spokenPunctuation"] as const;

/**
 * Validates a partial coming over IPC: keeps only settable fields with the right
 * type (known model ids, trimmed de-duplicated dictionary) and drops the rest.
 */
export function sanitizePrefsPatch(input: unknown): SettingsPatch {
  if (typeof input !== "object" || input === null) return {};
  const raw = input as Record<string, unknown>;
  const out: SettingsPatch = {};

  for (const key of BOOLEAN_FIELDS) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  // An id outside the list would reach Whisper as a language it may not know.
  if (typeof raw.language === "string" && isSupportedLanguage(raw.language)) out.language = raw.language;
  if (typeof raw.whisperModelId === "string" && getModelById("whisper", raw.whisperModelId)) {
    out.whisperModelId = raw.whisperModelId;
  }
  if (typeof raw.llmModelId === "string" && getModelById("llm", raw.llmModelId)) {
    out.llmModelId = raw.llmModelId;
  }
  if (Array.isArray(raw.dictionary) && raw.dictionary.every((t) => typeof t === "string")) {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const t of raw.dictionary as string[]) {
      const term = t.trim();
      if (!term || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      terms.push(term);
    }
    out.dictionary = terms;
  }
  return out;
}
