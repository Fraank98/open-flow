import { describe, it, expect } from "vitest";
import { normalizePillStyle, pillWindowSize, audioLevel } from "../../src/main/utils/pill-style.js";
import { sanitizePrefsPatch } from "../../src/main/utils/prefs-patch.js";
import { PreferencesStore } from "../../src/main/preferences-store.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("pill styles", () => {
  it("accepts only the three available styles", () => {
    for (const pillStyle of ["compact", "preview", "minimal"]) {
      expect(sanitizePrefsPatch({ pillStyle })).toEqual({ pillStyle });
      expect(normalizePillStyle(pillStyle)).toBe(pillStyle);
    }
    for (const value of [null, {}, "", "other"]) {
      expect(normalizePillStyle(value)).toBe("compact");
      expect(sanitizePrefsPatch({ pillStyle: value })).toEqual({});
    }
  });
  it("persists a choice and migrates missing or invalid values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pill-prefs-"));
    try {
      const path = join(dir, "prefs.json");
      const store = new PreferencesStore(path);
      expect((await store.load()).pillStyle).toBe("compact");
      await store.update({ pillStyle: "preview" });
      expect((await store.load()).pillStyle).toBe("preview");
      await writeFile(path, JSON.stringify({ pillStyle: "bad", language: "it" }));
      expect(await store.load()).toMatchObject({ pillStyle: "compact", language: "it" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("gives preview room for transcript, preserves full error messages and suggestions", () => {
    expect(pillWindowSize("preview", "recording")).toEqual({ width: 420, height: 188 });
    expect(pillWindowSize("minimal", "recording")).toEqual({ width: 286, height: 116 });
    expect(pillWindowSize("compact", "recording")).toEqual({ width: 370, height: 116 });
    for (const style of ["compact", "preview", "minimal"] as const) {
      expect(pillWindowSize(style, "paste-failed")).toEqual({ width: 420, height: 124 });
      expect(pillWindowSize(style, "suggesting")).toEqual({ width: 480, height: 520 });
    }
  });
  it("meters real samples and clamps silence, invalid input, and clipping", () => {
    expect(audioLevel(new Float32Array())).toBe(0);
    expect(audioLevel(new Float32Array([0, 0]))).toBe(0);
    expect(audioLevel(new Float32Array([0.05, -0.05]))).toBeCloseTo(0.4);
    expect(audioLevel(new Float32Array([1, -1]))).toBe(1);
    expect(audioLevel(new Float32Array([NaN]))).toBe(0);
  });
});
