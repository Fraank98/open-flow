import type { CatalogModel, TierDescriptor } from "../model-catalog.js";
import type { Preferences } from "../preferences-store.js";

export interface BootModelsDeps {
  getModelById: (kind: "whisper" | "llm", id: string) => CatalogModel | undefined;
  tierForModels: (whisperId: string, llmId: string) => Pick<TierDescriptor, "id"> | undefined;
  isInstalled: (desc: CatalogModel) => Promise<boolean>;
}

export type BootModelsResult =
  | { ok: true; whisper: CatalogModel; llm: CatalogModel }
  | {
      ok: false;
      /** Why the app cannot boot: the id is not in the catalog, or a model file is gone from disk. */
      reason: "unknown-model" | "missing-file";
      /** The preferences update that sends the user back to the download step. */
      patch: Partial<Preferences>;
    };

/**
 * Resolves the whisper and LLM models the preferences point at and checks that
 * their files exist. When they cannot be used it returns the prefs patch that
 * resumes setup at the download step (bug 604fa07), instead of the "welcome"
 * step with no context.
 */
export async function resolveBootModels(
  prefs: Pick<Preferences, "whisperModelId" | "llmModelId" | "setupTierId">,
  deps: BootModelsDeps,
): Promise<BootModelsResult> {
  const whisper = deps.getModelById("whisper", prefs.whisperModelId);
  const llm = deps.getModelById("llm", prefs.llmModelId);
  if (!whisper || !llm) {
    return {
      ok: false,
      reason: "unknown-model",
      patch: { setupComplete: false, setupStep: "download", setupReason: "missing-model" },
    };
  }
  // Short-circuits like the inline code it replaced: the LLM file is not
  // checked once the whisper file is already known to be missing.
  if (!(await deps.isInstalled(whisper)) || !(await deps.isInstalled(llm))) {
    return {
      ok: false,
      reason: "missing-file",
      patch: {
        setupComplete: false,
        setupStep: "download",
        setupReason: "missing-model",
        // The download step needs a tier: use the one these models belong to
        // (the wizard falls back to the tier chooser when there is none).
        setupTierId: deps.tierForModels(prefs.whisperModelId, prefs.llmModelId)?.id ?? prefs.setupTierId,
      },
    };
  }
  return { ok: true, whisper, llm };
}
