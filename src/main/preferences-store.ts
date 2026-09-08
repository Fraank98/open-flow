import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface Preferences {
  setupComplete: boolean;
  whisperModelId: string;
  llmModelId: string;
  hotkeyAccelerator: string;
  language: string;
  debugLogging: boolean;
  useLlmCleanup: boolean;
  launchAtLogin: boolean;
  spokenPunctuation: boolean;
  /** User-defined preferred spellings normalized in the transcript and used to
   *  bias Whisper (proper nouns, product names, jargon). */
  dictionary: string[];
  /** The name the user appears with in chats and mails ("Danilo", "Danilo
   *  Franco"). The reply-suggestions parser compares it — normalized on case,
   *  accents and whitespace, on the full string and on its first token — with
   *  the speaker of each turn to tell the user's turns from the counterpart's.
   *  Empty means "not configured": the feature cannot be enabled without it. */
  userDisplayName: string;
  /** Reply suggestions (context → three proposed replies). Off by default:
   *  off means no second llama-server, no extra RAM, identical behaviour. */
  replySuggestionsEnabled: boolean;
  /** Electron accelerator. Must not contain Alt/Option: dictation holds
   *  Option through the native modifier monitor (utils/reply-hotkey.ts). */
  replySuggestionsHotkey: string;
  /** Id in REPLY_MODELS, chosen through REPLY_TIERS in the UI. */
  replyModelId: string;
  /** allowlist: read only the listed apps (default). blocklist: read all but them. */
  replyAppsMode: "allowlist" | "blocklist";
  /** Bundle ids. Compared case-insensitively by AxContextReader. */
  replyApps: string[];
}

export const DEFAULT_PREFS: Preferences = {
  setupComplete: false,
  whisperModelId: "whisper-small",
  llmModelId: "qwen-1.5b",
  hotkeyAccelerator: "Hold Option",
  language: "auto",
  debugLogging: false,
  useLlmCleanup: true,
  launchAtLogin: true,
  spokenPunctuation: false,
  dictionary: [],
  userDisplayName: "",
  replySuggestionsEnabled: false,
  replySuggestionsHotkey: "Command+Control+R",
  replyModelId: "gemma-3-4b",
  replyAppsMode: "allowlist",
  replyApps: ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"],
};

export class PreferencesStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Preferences> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<Preferences>;
      return { ...DEFAULT_PREFS, ...parsed };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  async save(prefs: Preferences): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(prefs, null, 2), "utf8");
    await rename(tmp, this.path);
  }

  async update(partial: Partial<Preferences>): Promise<Preferences> {
    const current = await this.load();
    const next = { ...current, ...partial };
    await this.save(next);
    return next;
  }
}
