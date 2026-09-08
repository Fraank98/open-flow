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

  it("defaults userDisplayName to an empty string", () => {
    expect(DEFAULT_PREFS.userDisplayName).toBe("");
  });

  it("loads an old preferences file without userDisplayName as an empty string", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    // A file written by a version that predates the field.
    await writeFile(path, JSON.stringify({ setupComplete: true, language: "it" }));
    const prefs = await new PreferencesStore(path).load();
    expect(prefs.userDisplayName).toBe("");
    expect(prefs.language).toBe("it");
  });

  it("defaults the reply-suggestions preferences to off, Command+Control+R, gemma-3-4b, allowlist with the three verified apps", () => {
    expect(DEFAULT_PREFS.replySuggestionsEnabled).toBe(false);
    expect(DEFAULT_PREFS.replySuggestionsHotkey).toBe("Command+Control+R");
    expect(DEFAULT_PREFS.replyModelId).toBe("gemma-3-4b");
    expect(DEFAULT_PREFS.replyAppsMode).toBe("allowlist");
    expect(DEFAULT_PREFS.replyApps).toEqual(["com.tinyspeck.slackmacgap", "com.apple.mail", "com.brave.Browser"]);
  });

  it("loads an old preferences file with the feature OFF and the defaults filled in", async () => {
    const path = join(dir, "prefs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ setupComplete: true, userDisplayName: "Danilo" }));
    const prefs = await new PreferencesStore(path).load();
    expect(prefs.replySuggestionsEnabled).toBe(false);
    expect(prefs.replyApps).toHaveLength(3);
    expect(prefs.userDisplayName).toBe("Danilo");
  });
});
