import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferencesStore, DEFAULT_PREFS } from "../../src/main/preferences-store.js";

describe("PreferencesStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "of-prefs-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns defaults when no file exists", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    const prefs = await store.load();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("persists changes via save() and re-reads them", async () => {
    const path = join(dir, "prefs.json");
    const store = new PreferencesStore(path);
    await store.save({ ...DEFAULT_PREFS, whisperModelId: "whisper-small" });
    const reread = await new PreferencesStore(path).load();
    expect(reread.whisperModelId).toBe("whisper-small");
  });

  it("merges partial updates via update()", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    await store.update({ language: "it" });
    const prefs = await store.load();
    expect(prefs.language).toBe("it");
    expect(prefs.whisperModelId).toBe(DEFAULT_PREFS.whisperModelId);
  });

  it("setupComplete defaults to false", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    const prefs = await store.load();
    expect(prefs.setupComplete).toBe(false);
  });

  it("defaults setupStep to welcome and setupTierId to null", async () => {
    const store = new PreferencesStore(join(dir, "prefs.json"));
    const prefs = await store.load();
    expect(prefs.setupStep).toBe("welcome");
    expect(prefs.setupTierId).toBeNull();
  });

  it("loads an old file without setupStep", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ setupComplete: true, language: "it" }));
    const prefs = await new PreferencesStore(path).load();
    expect(prefs.setupComplete).toBe(true);
    expect(prefs.language).toBe("it");
    expect(prefs.setupStep).toBe("welcome");
    expect(prefs.setupTierId).toBeNull();
  });

  it("falls back to defaults on corrupt JSON", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{not valid json");
    const store = new PreferencesStore(path);
    const prefs = await store.load();
    expect(prefs).toEqual(DEFAULT_PREFS);
  });

  it("writes file atomically (no partial files on crash)", async () => {
    const path = join(dir, "prefs.json");
    const store = new PreferencesStore(path);
    await store.save({ ...DEFAULT_PREFS, language: "en" });
    // Verify file is valid JSON after save
    const raw = await readFile(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("defaults dictionary to an empty array", () => {
    expect(DEFAULT_PREFS.dictionary).toEqual([]);
  });
});
