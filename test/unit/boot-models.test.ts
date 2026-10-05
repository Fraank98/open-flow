import { describe, it, expect, vi } from "vitest";
import { resolveBootModels, type BootModelsDeps } from "../../src/main/utils/boot-models.js";
import type { CatalogModel } from "../../src/main/model-catalog.js";

function model(id: string): CatalogModel {
  return {
    id,
    label: id,
    filename: `${id}.bin`,
    url: `https://example.test/${id}`,
    sha256: "0".repeat(64),
    sizeBytes: 1,
    description: id,
    ramBytes: 1,
    licenseNote: null,
  };
}

const prefs = { whisperModelId: "w1", llmModelId: "l1", setupTierId: "saved-tier" };

function makeDeps(overrides: Partial<BootModelsDeps> = {}): BootModelsDeps {
  return {
    getModelById: vi.fn<BootModelsDeps["getModelById"]>((_kind, id) => model(id)),
    tierForModels: vi.fn<BootModelsDeps["tierForModels"]>(() => ({ id: "balanced" })),
    isInstalled: vi.fn<BootModelsDeps["isInstalled"]>(async () => true),
    ...overrides,
  };
}

describe("resolveBootModels", () => {
  it("returns both descriptors when they are known and installed", async () => {
    const deps = makeDeps();
    const r = await resolveBootModels(prefs, deps);
    expect(r).toEqual({ ok: true, whisper: model("w1"), llm: model("l1") });
    expect(deps.getModelById).toHaveBeenCalledWith("whisper", "w1");
    expect(deps.getModelById).toHaveBeenCalledWith("llm", "l1");
  });

  it.each([
    ["whisper", (kind: string) => kind === "whisper"],
    ["llm", (kind: string) => kind === "llm"],
  ])("unknown %s id: resumes at download without touching setupTierId", async (_name, unknown) => {
    const deps = makeDeps({
      getModelById: vi.fn<BootModelsDeps["getModelById"]>((kind, id) => (unknown(kind) ? undefined : model(id))),
    });
    const r = await resolveBootModels(prefs, deps);
    expect(r).toEqual({
      ok: false,
      reason: "unknown-model",
      patch: { setupComplete: false, setupStep: "download", setupReason: "missing-model" },
    });
    expect(r.ok === false && "setupTierId" in r.patch).toBe(false);
    expect(deps.isInstalled).not.toHaveBeenCalled();
  });

  it("missing file: resumes at download with the tier these models belong to", async () => {
    const deps = makeDeps({ isInstalled: vi.fn<BootModelsDeps["isInstalled"]>(async (d) => d.id !== "l1") });
    const r = await resolveBootModels(prefs, deps);
    expect(r).toEqual({
      ok: false,
      reason: "missing-file",
      patch: { setupComplete: false, setupStep: "download", setupReason: "missing-model", setupTierId: "balanced" },
    });
    expect(deps.tierForModels).toHaveBeenCalledWith("w1", "l1");
  });

  it("missing file with no matching tier: falls back to the saved setupTierId (or null)", async () => {
    const deps = makeDeps({
      isInstalled: vi.fn<BootModelsDeps["isInstalled"]>(async () => false),
      tierForModels: vi.fn<BootModelsDeps["tierForModels"]>(() => undefined),
    });
    const r = await resolveBootModels(prefs, deps);
    expect(r.ok === false && r.patch.setupTierId).toBe("saved-tier");

    const r2 = await resolveBootModels({ ...prefs, setupTierId: null }, deps);
    expect(r2.ok === false && r2.patch.setupTierId).toBeNull();
  });

  it("does not check the LLM file once the whisper file is missing", async () => {
    const deps = makeDeps({ isInstalled: vi.fn<BootModelsDeps["isInstalled"]>(async () => false) });
    await resolveBootModels(prefs, deps);
    expect(deps.isInstalled).toHaveBeenCalledTimes(1);
    expect(deps.isInstalled).toHaveBeenCalledWith(model("w1"));
  });
});
