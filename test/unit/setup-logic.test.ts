import { describe, it, expect } from "vitest";
import "../../src/renderer/lib/setup-logic.js";
import { formatBytes as formatBytesMain } from "../../src/main/utils/format-bytes.js";

interface SetupLogic {
  permissionBadge(status: string | undefined): { text: string; cls: string };
  canContinuePermissions(state: Record<string, string>): boolean;
  formatBytes(n: number): string;
  downloadStats(
    samples: Array<{ t: number; bytes: number }>,
    total: number,
  ): { bytesPerSec: number; etaSec: number | null };
  pruneSamples(
    samples: Array<{ t: number; bytes: number }>,
  ): Array<{ t: number; bytes: number }>;
  formatEta(sec: number | null): string;
  estimateMinutes(bytes: number, bytesPerSec: number): number;
  resumeStep(prefs: { setupStep?: string; setupTierId?: string | null }): string;
  tierCardLines(tier: TierView): string[];
  readyStepText(state: string | undefined): string;
  pipelineView(prev: string | undefined, next: string): string;
  freeSpaceInfo(freeBytes: number | null, tier: TierView | undefined): { text: string; low: boolean } | null;
}
interface TierView {
  summary: string;
  transcriptionNote: string;
  sizeBytes: number;
  ramBytes: number;
  installed?: boolean;
  licenseNote: string | null;
}
const L = (globalThis as unknown as { OpenFlowSetupLogic: SetupLogic }).OpenFlowSetupLogic;

describe("permissionBadge", () => {
  it("maps statuses to text and css class", () => {
    expect(L.permissionBadge("granted")).toEqual({ text: "Granted", cls: "granted" });
    expect(L.permissionBadge("denied")).toEqual({ text: "Denied — fix in System Settings", cls: "denied" });
    expect(L.permissionBadge("unknown")).toEqual({ text: "Not asked yet", cls: "pending" });
    expect(L.permissionBadge(undefined)).toEqual({ text: "Not asked yet", cls: "pending" });
  });
});

describe("canContinuePermissions", () => {
  const ok = { micPermission: "granted", accessibilityPermission: "granted", automationPermission: "granted" };
  it("requires all three permissions (Automation is mandatory)", () => {
    expect(L.canContinuePermissions(ok)).toBe(true);
    expect(L.canContinuePermissions({ ...ok, automationPermission: "unknown" })).toBe(false);
    expect(L.canContinuePermissions({ ...ok, accessibilityPermission: "denied" })).toBe(false);
    expect(L.canContinuePermissions({ ...ok, micPermission: "unknown" })).toBe(false);
    expect(L.canContinuePermissions({})).toBe(false);
  });
});

describe("formatBytes", () => {
  it("formats decimal sizes", () => {
    expect(L.formatBytes(487_601_967)).toBe("490 MB");
    expect(L.formatBytes(1_624_555_275)).toBe("1.6 GB");
    expect(L.formatBytes(1_624_555_275 + 2_104_932_768)).toBe("3.7 GB");
  });

  it("follows exactly the same rule as the main-process formatBytes", () => {
    const values = [
      0, 1, 999, 400_000, 1_000_000, 62_000_000, 99_400_000, 99_600_000, 487_601_967, 491_400_032,
      999_600_000, 999_999_999, 1_000_000_000, 1_117_320_736, 1_624_555_275, 2_104_932_768,
      3_729_488_043, 42_000_000_000, -5,
    ];
    for (const v of values) expect(L.formatBytes(v)).toBe(formatBytesMain(v));
  });
});

describe("downloadStats", () => {
  it("has no ETA with fewer than two samples", () => {
    expect(L.downloadStats([], 100)).toEqual({ bytesPerSec: 0, etaSec: null });
    expect(L.downloadStats([{ t: 0, bytes: 10 }], 100)).toEqual({ bytesPerSec: 0, etaSec: null });
  });

  it("computes speed and ETA over a sliding 5 s window", () => {
    const samples = [
      { t: 0, bytes: 0 },
      { t: 4_000, bytes: 40_000_000 }, // old slow-start sample, will fall out of the window
      { t: 10_000, bytes: 100_000_000 },
      { t: 12_000, bytes: 120_000_000 },
      { t: 15_000, bytes: 150_000_000 },
    ];
    // window = samples with t >= 10_000: 50 MB in 5 s
    const s = L.downloadStats(samples, 490_000_000);
    expect(s.bytesPerSec).toBe(10_000_000);
    expect(s.etaSec).toBe(34);
  });

  it("has no ETA when nothing moved", () => {
    const s = L.downloadStats([{ t: 0, bytes: 5 }, { t: 1000, bytes: 5 }], 100);
    expect(s.bytesPerSec).toBe(0);
    expect(s.etaSec).toBeNull();
  });
});

describe("formatEta", () => {
  it("formats seconds and minutes", () => {
    expect(L.formatEta(95)).toBe("about 2 min left");
    expect(L.formatEta(20)).toBe("20 s left");
    expect(L.formatEta(0.4)).toBe("1 s left");
    expect(L.formatEta(null)).toBe("");
  });
});

describe("estimateMinutes", () => {
  it("rounds up to whole minutes, at least 1", () => {
    const bps = 100e6 / 8;
    expect(L.estimateMinutes(1_604_922_703, bps)).toBe(3);
    expect(L.estimateMinutes(10_000_000, bps)).toBe(1);
  });
});

describe("resumeStep", () => {
  it("restarts from the saved step, never beyond download", () => {
    expect(L.resumeStep({ setupStep: "permissions", setupTierId: null })).toBe("permissions");
    expect(L.resumeStep({ setupStep: "tier", setupTierId: "balanced" })).toBe("tier");
    expect(L.resumeStep({ setupStep: "download", setupTierId: "balanced" })).toBe("download");
    expect(L.resumeStep({ setupStep: "ready", setupTierId: "balanced" })).toBe("download");
  });

  it("falls back to the tier step when no tier was chosen, and to welcome for junk", () => {
    expect(L.resumeStep({ setupStep: "download", setupTierId: null })).toBe("tier");
    expect(L.resumeStep({ setupStep: "ready", setupTierId: null })).toBe("tier");
    expect(L.resumeStep({})).toBe("welcome");
    expect(L.resumeStep({ setupStep: "bogus" })).toBe("welcome");
  });
});

describe("tierCardLines", () => {
  const balanced: TierView = {
    summary: "Whisper Small + Qwen 1.5B",
    transcriptionNote: "Recommended for most Macs.",
    sizeBytes: 487_601_967 + 1_117_320_736,
    ramBytes: 2_400_000_000,
    licenseNote: null,
  };

  it("lists summary, size/RAM/time meta and the transcription note", () => {
    expect(L.tierCardLines(balanced)).toEqual([
      "Whisper Small + Qwen 1.5B",
      "1.6 GB download · ~2.4 GB of RAM while running · about 3 min on a 100 Mbps connection",
      "Recommended for most Macs.",
    ]);
  });

  it("puts the license note last when present", () => {
    const max: TierView = {
      ...balanced,
      sizeBytes: 1_624_555_275 + 2_104_932_768,
      licenseNote: "The 3B cleanup model is licensed for non-commercial use only.",
    };
    const lines = L.tierCardLines(max);
    expect(lines[1]).toContain("3.7 GB download");
    expect(lines[lines.length - 1]).toBe("The 3B cleanup model is licensed for non-commercial use only.");
  });
});

describe("freeSpaceInfo", () => {
  const tier: TierView = { summary: "", transcriptionNote: "", sizeBytes: 1_604_922_703, ramBytes: 0, licenseNote: null };
  it("reports free space and flags it when the tier would not fit", () => {
    expect(L.freeSpaceInfo(42_000_000_000, tier)).toEqual({ text: "Free space on this Mac: 42.0 GB", low: false });
    expect(L.freeSpaceInfo(900_000_000, tier)).toEqual({ text: "Free space on this Mac: 900 MB", low: true });
    expect(L.freeSpaceInfo(900_000_000, { ...tier, installed: true })?.low).toBe(false);
    expect(L.freeSpaceInfo(null, tier)).toBeNull();
  });
});

describe("readyStepText", () => {
  it("describes each pipeline state in a few words", () => {
    expect(L.readyStepText("recording")).toBe("Listening…");
    expect(L.readyStepText("transcribing")).toBe("Transcribing…");
    expect(L.readyStepText("cleaning")).toBe("Cleaning up…");
    expect(L.readyStepText("pasting")).toBe("Pasting…");
    expect(L.readyStepText("pasted")).toBe("Pasted — nice.");
    expect(L.readyStepText("idle")).toBe("Waiting for you…");
    expect(L.readyStepText(undefined)).toBe("Waiting for you…");
  });
});

describe("pipelineView", () => {
  it("turns pasting -> idle into the pasted confirmation, and passes other states through", () => {
    expect(L.pipelineView("pasting", "idle")).toBe("pasted");
    expect(L.pipelineView("recording", "idle")).toBe("idle");
    expect(L.pipelineView("idle", "recording")).toBe("recording");
    expect(L.pipelineView(undefined, "idle")).toBe("idle");
  });
});

describe("pruneSamples", () => {
  it("drops samples older than the 5 s window ending at the last one", () => {
    const samples = [0, 1000, 2000, 6000, 7000, 8000].map((t) => ({ t, bytes: t }));
    expect(L.pruneSamples(samples).map((s) => s.t)).toEqual([6000, 7000, 8000]);
  });

  it("keeps the samples inside the window, boundary included", () => {
    const samples = [1000, 3000, 6000].map((t) => ({ t, bytes: t }));
    expect(L.pruneSamples(samples).map((s) => s.t)).toEqual([1000, 3000, 6000]);
  });

  it("keeps at least the last two samples, so a stall still yields a (zero) speed", () => {
    const samples = [0, 20_000].map((t) => ({ t, bytes: t }));
    expect(L.pruneSamples(samples)).toHaveLength(2);
    expect(L.pruneSamples([{ t: 0, bytes: 0 }])).toHaveLength(1);
    expect(L.pruneSamples([])).toEqual([]);
  });

  it("keeps the array bounded over a long stream and leaves the stats unchanged", () => {
    let samples: Array<{ t: number; bytes: number }> = [];
    const full: Array<{ t: number; bytes: number }> = [];
    for (let i = 0; i < 20_000; i++) {
      const s = { t: i * 10, bytes: i * 1000 };
      full.push(s);
      samples.push(s);
      samples = L.pruneSamples(samples);
    }
    // 5 s at one sample per 10 ms.
    expect(samples.length).toBeLessThanOrEqual(502);
    expect(L.downloadStats(samples, 50_000_000)).toEqual(L.downloadStats(full, 50_000_000));
  });
});
