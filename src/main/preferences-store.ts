import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Wizard steps in order; saved so an interrupted setup resumes where it stopped. */
export type SetupStep = "welcome" | "permissions" | "tier" | "download" | "ready";

/** Why setup reopened on its own, when it was not the first run. */
export type SetupReason = "missing-model";

export interface Preferences {
  setupComplete: boolean;
  /** Last wizard step reached while setup is incomplete. */
  setupStep: SetupStep;
  /** Set when the app sent the user back to setup (e.g. a model file vanished); cleared once setup completes. */
  setupReason: SetupReason | null;
  /** Quality level chosen in the wizard, or null before the choice. */
  setupTierId: string | null;
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
}

export const DEFAULT_PREFS: Preferences = {
  setupComplete: false,
  setupStep: "welcome",
  setupReason: null,
  setupTierId: null,
  whisperModelId: "whisper-small",
  llmModelId: "qwen-1.5b",
  hotkeyAccelerator: "Hold Option",
  language: "auto",
  debugLogging: false,
  useLlmCleanup: true,
  launchAtLogin: true,
  spokenPunctuation: false,
  dictionary: [],
};

export class PreferencesStore {
  /** Tail of the update chain: read-modify-write cycles run strictly one after another. */
  private updateQueue: Promise<unknown> = Promise.resolve();

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

  /**
   * Merges `partial` into the saved prefs. Updates are serialised here, in the
   * store, because several writers (the wizard, Settings, boot) share it: two
   * overlapping load -> merge -> save cycles would each start from the same
   * snapshot and the later write would silently drop the earlier one's fields.
   */
  update(partial: Partial<Preferences>): Promise<Preferences> {
    const run = async (): Promise<Preferences> => {
      const current = await this.load();
      const next = { ...current, ...partial };
      await this.save(next);
      return next;
    };
    // A failed update rejects its own caller but must not wedge the queue.
    const result = this.updateQueue.then(run, run);
    this.updateQueue = result.catch(() => undefined);
    return result;
  }
}
