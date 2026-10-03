import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/settings-logic.js";
import { formatBytes as formatBytesMain } from "../../src/main/utils/format-bytes.js";

interface ModelView {
  id: string;
  sizeBytes: number;
  ramBytes: number;
  installed: boolean;
  licenseNote: string | null;
}
interface SettingsLogic {
  restartBadgeFor(field: string, restartFields: string[]): string | null;
  bannerVisible(restartFields: string[]): boolean;
  modelRowView(
    model: ModelView,
    selectedId: string,
  ): { primaryAction: "use" | "download" | "active"; canDelete: boolean; licenseNote: string | null };
  storageSummary(models: ModelView[]): string;
  tabFromHash(hash: string, available?: string[]): string;
  cleanIpcError(message: unknown): string;
  formatBytes(n: number): string;
  modelMeta(model: ModelView): string;
  permissionRow(status: string | null | undefined): { text: string; granted: boolean };
}
const L = (globalThis as unknown as { OpenFlowSettingsLogic: SettingsLogic }).OpenFlowSettingsLogic;

const NOTE = "The 3B cleanup model is licensed for non-commercial use only.";
const model = (over: Partial<ModelView> = {}): ModelView => ({
  id: "a",
  sizeBytes: 487_601_967,
  ramBytes: 1_000_000_000,
  installed: true,
  licenseNote: null,
  ...over,
});

describe("restartBadgeFor / bannerVisible", () => {
  it("shows the badge only for fields that are pending a restart", () => {
    expect(L.restartBadgeFor("llmModelId", ["llmModelId"])).toBe("Restart required");
    expect(L.restartBadgeFor("whisperModelId", ["llmModelId"])).toBeNull();
    expect(L.restartBadgeFor("llmModelId", [])).toBeNull();
  });

  it("shows the banner while at least one field is pending", () => {
    expect(L.bannerVisible(["useLlmCleanup"])).toBe(true);
    expect(L.bannerVisible([])).toBe(false);
    expect(L.bannerVisible(undefined as unknown as string[])).toBe(false);
  });
});

describe("modelRowView", () => {
  it("marks the selected installed model as active and not deletable", () => {
    expect(L.modelRowView(model({ id: "a" }), "a")).toEqual({ primaryAction: "active", canDelete: false, licenseNote: null });
  });

  it("offers Download for a model that is not installed", () => {
    expect(L.modelRowView(model({ installed: false }), "b")).toEqual({
      primaryAction: "download",
      canDelete: false,
      licenseNote: null,
    });
  });

  it("offers Use and Delete for an installed model that is not active", () => {
    expect(L.modelRowView(model({ id: "a" }), "b")).toEqual({ primaryAction: "use", canDelete: true, licenseNote: null });
  });

  it("passes the license note through untouched", () => {
    expect(L.modelRowView(model({ installed: false, licenseNote: NOTE }), "b").licenseNote).toBe(NOTE);
    expect(L.modelRowView(model({ licenseNote: NOTE }), "a").licenseNote).toBe(NOTE);
  });
});

describe("storageSummary", () => {
  it("sums the installed models only", () => {
    const models = [
      model({ sizeBytes: 487_601_967 }),
      model({ sizeBytes: 1_117_320_736 }),
      model({ sizeBytes: 2_104_932_768, installed: false }),
    ];
    expect(L.storageSummary(models)).toBe("Models on disk: 1.6 GB");
  });

  it("handles an empty disk", () => {
    expect(L.storageSummary([])).toBe("Models on disk: 0 MB");
  });
});

describe("tabFromHash", () => {
  it("reads the tab id from the hash and falls back to general", () => {
    expect(L.tabFromHash("#models")).toBe("models");
    expect(L.tabFromHash("#reply")).toBe("reply");
    expect(L.tabFromHash("")).toBe("general");
    expect(L.tabFromHash("#")).toBe("general");
    expect(L.tabFromHash("#not a tab!")).toBe("general");
  });

  it("falls back to general for ids missing from the available tabs", () => {
    expect(L.tabFromHash("#models", ["general", "models"])).toBe("models");
    expect(L.tabFromHash("#reply", ["general", "models"])).toBe("general");
  });
});

describe("cleanIpcError", () => {
  it("strips Electron's remote-method prefix", () => {
    expect(
      L.cleanIpcError("Error invoking remote method 'prefs:delete-model': Error: Can't delete the active model."),
    ).toBe("Can't delete the active model.");
    expect(L.cleanIpcError("Error invoking remote method 'prefs:update': TypeError: nope")).toBe("TypeError: nope");
  });

  it("leaves other messages alone and copes with non-strings", () => {
    expect(L.cleanIpcError("Download failed. Try again.")).toBe("Download failed. Try again.");
    expect(L.cleanIpcError(new Error("Error invoking remote method 'x': Error: boom"))).toBe("boom");
    expect(L.cleanIpcError(undefined)).toBe("Something went wrong.");
  });
});

describe("formatBytes / modelMeta", () => {
  it("uses decimal units like the main-process formatBytes", () => {
    expect(L.formatBytes(487_601_967)).toBe("490 MB");
    expect(L.formatBytes(1_624_555_275)).toBe("1.6 GB");
    const values = [0, 1, 99_600_000, 465_000_000, 487_601_967, 999_700_000, 1_117_320_736, 2_104_932_768];
    for (const v of values) expect(L.formatBytes(v)).toBe(formatBytesMain(v));
  });

  it("describes a model as size and RAM", () => {
    expect(L.modelMeta(model())).toBe("490 MB · ~1.0 GB RAM");
  });
});

describe("permissionRow", () => {
  it("maps a status to text", () => {
    expect(L.permissionRow("granted")).toEqual({ text: "Granted", granted: true });
    expect(L.permissionRow("denied")).toEqual({ text: "Not granted", granted: false });
    expect(L.permissionRow("unknown")).toEqual({ text: "Not asked yet", granted: false });
    expect(L.permissionRow(null)).toEqual({ text: "Not asked yet", granted: false });
  });
});
