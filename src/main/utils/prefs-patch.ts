import { getModelById } from "../model-catalog.js";
import { isSupportedLanguage } from "./languages.js";
import { validateReplyAccelerator } from "./reply-hotkey.js";
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
    | "replySuggestionsEnabled"
    | "userDisplayName"
    | "replySuggestionsHotkey"
    | "replyModelId"
    | "replyAppsMode"
    | "replyApps"
  >
>;

const BOOLEAN_FIELDS = [
  "debugLogging",
  "useLlmCleanup",
  "launchAtLogin",
  "spokenPunctuation",
  "replySuggestionsEnabled",
] as const;

const DISPLAY_NAME_MAX = 100;
// A reverse-DNS bundle id: no spaces, no path separators.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

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
  if (typeof raw.replyModelId === "string" && getModelById("reply", raw.replyModelId)) {
    out.replyModelId = raw.replyModelId;
  }
  if (raw.replyAppsMode === "allowlist" || raw.replyAppsMode === "blocklist") out.replyAppsMode = raw.replyAppsMode;
  if (typeof raw.userDisplayName === "string") out.userDisplayName = raw.userDisplayName.trim().slice(0, DISPLAY_NAME_MAX);
  if (typeof raw.replySuggestionsHotkey === "string") {
    const accelerator = raw.replySuggestionsHotkey.trim();
    if (validateReplyAccelerator(accelerator).ok) out.replySuggestionsHotkey = accelerator;
  }
  if (Array.isArray(raw.replyApps) && raw.replyApps.every((a) => typeof a === "string")) {
    const seen = new Set<string>();
    const apps: string[] = [];
    for (const a of raw.replyApps as string[]) {
      const id = a.trim();
      if (!BUNDLE_ID.test(id) || seen.has(id.toLowerCase())) continue;
      seen.add(id.toLowerCase());
      apps.push(id);
    }
    out.replyApps = apps;
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
