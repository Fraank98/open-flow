import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelManager } from "../../src/main/model-manager.js";
import { DEFAULT_PREFS, PreferencesStore, type Preferences } from "../../src/main/preferences-store.js";
import { LLM_MODELS, WHISPER_MODELS, getModelById, type CatalogModel } from "../../src/main/model-catalog.js";
import { SetupWizard } from "../../src/main/setup-wizard.js";
import { app, dialog, ipcMain, resetElectronMock, shell, systemPreferences, FakeBrowserWindow } from "../helpers/electron-mock.js";
import { deferred } from "../helpers/deferred.js";

vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);

// No real disk: the free-space probe and the models directory are stubbed.
const diskSpace = vi.hoisted(() => ({ ensureFreeSpace: vi.fn(async (_dir: string, _needed: number) => 12_345) }));
vi.mock("../../src/main/utils/disk-space.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/utils/disk-space.js")>()),
  ensureFreeSpace: diskSpace.ensureFreeSpace,
}));
const fsMock = vi.hoisted(() => ({ mkdir: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  mkdir: fsMock.mkdir,
}));
// The Automation probe would run osascript.
const probe = vi.hoisted(() => ({ checkAutomationViaProbe: vi.fn(async () => "granted" as const) }));
vi.mock("../../src/main/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/permissions.js")>()),
  checkAutomationViaProbe: probe.checkAutomationViaProbe,
}));

function catalogModel(kind: "whisper" | "llm", id: string): CatalogModel {
  const m = getModelById(kind, id);
  if (!m) throw new Error(`unknown catalog model ${id}`);
  return m;
}
const WHISPER = catalogModel("whisper", "whisper-small");
const LLM = catalogModel("llm", "qwen-1.5b");

/** Lets fire-and-forget promise chains (dialog.then, store.update) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup() {
  const modelManager = new ModelManager();
  const installed = new Set<string>();
  vi.spyOn(modelManager, "isInstalled").mockImplementation(async (d) => installed.has(d.id));
  const download = vi.spyOn(modelManager, "download").mockImplementation(async () => undefined);
  const removeOrphanPartials = vi.spyOn(modelManager, "removeOrphanPartials").mockResolvedValue(undefined);

  const preferencesStore = new PreferencesStore("/nonexistent/prefs.json");
  let prefs: Preferences = { ...DEFAULT_PREFS };
  vi.spyOn(preferencesStore, "load").mockImplementation(async () => ({ ...prefs }));
  const update = vi.spyOn(preferencesStore, "update").mockImplementation(async (patch) => {
    prefs = { ...prefs, ...patch };
    return prefs;
  });

  const accessibility = { isTrusted: vi.fn(() => true), requestTrust: vi.fn(() => true) };
  const wizard = new SetupWizard({ modelManager, preferencesStore, accessibility });
  return { wizard, installed, download, removeOrphanPartials, update, accessibility, setPrefs: (p: Partial<Preferences>) => (prefs = { ...prefs, ...p }) };
}

function win(): FakeBrowserWindow {
  const w = FakeBrowserWindow.instances[0];
  if (!w) throw new Error("no window was created");
  return w;
}

beforeEach(() => {
  resetElectronMock();
  diskSpace.ensureFreeSpace.mockReset().mockResolvedValue(12_345);
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  probe.checkAutomationViaProbe.mockReset().mockResolvedValue("granted");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SetupWizard window lifecycle", () => {
  it("creates the window, registers every channel, and on close resolves false and unregisters them all", async () => {
    const { wizard } = setup();
    const result = wizard.run();
    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(wizard.isOpen()).toBe(true);
    expect(ipcMain.handlers.size + ipcMain.listeners.size).toBeGreaterThan(0);

    win().destroy();

    await expect(result).resolves.toBe(false);
    expect(wizard.isOpen()).toBe(false);
    expect(ipcMain.handlers.size).toBe(0);
    expect(ipcMain.listeners.size).toBe(0);
  });

  it("asks before closing halfway, once even when close fires twice while the dialog is open", async () => {
    const { wizard } = setup();
    const result = wizard.run();
    const answer = deferred<{ response: number }>();
    dialog.showMessageBox.mockReturnValueOnce(answer.promise);
    const preventDefault = vi.fn();

    win().emit("close", { preventDefault });
    win().emit("close", { preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    answer.resolve({ response: 1 }); // Keep Going
    await settle();
    expect(win().destroyed).toBe(false);

    // The dialog can be shown again afterwards.
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }); // Quit Setup
    win().close();
    await settle();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(win().destroyed).toBe(true);
    await expect(result).resolves.toBe(false);
  });

  it("aborts the download in flight when the user confirms quitting", async () => {
    const { wizard, download } = setup();
    const result = wizard.run();
    const hold = deferred();
    let signal: AbortSignal | undefined;
    download.mockImplementation(async (_d, _p, opts) => {
      signal = opts?.signal;
      await hold.promise;
    });
    const started = ipcMain.invoke("setup:start-download", "balanced");
    await settle();
    expect(signal?.aborted).toBe(false);

    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
    win().close();
    await settle();

    expect(signal?.aborted).toBe(true);
    await expect(result).resolves.toBe(false);
    hold.resolve();
    await started;
  });

  it("aborts the download in flight when the window goes away without the confirmation dialog", async () => {
    const { wizard, download } = setup();
    const result = wizard.run();
    const hold = deferred();
    let signal: AbortSignal | undefined;
    download.mockImplementation(async (_d, _p, opts) => {
      signal = opts?.signal;
      await hold.promise;
    });
    const started = ipcMain.invoke("setup:start-download", "balanced");
    await settle();

    win().destroy();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    await expect(result).resolves.toBe(false);
    hold.resolve();
    await started;
  });

  it("closes without asking once setup is saved", async () => {
    const { wizard } = setup();
    const result = wizard.run();
    await ipcMain.invoke("setup:start-download", "balanced");
    await expect(result).resolves.toBe(true);

    win().close();

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(win().destroyed).toBe(true);
  });

  it("setup:finish closes the window", async () => {
    const { wizard } = setup();
    void wizard.run();
    const close = vi.spyOn(win(), "close");
    ipcMain.emit("setup:finish");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("setReadyState, sendPipelineState and focus only touch a live window", async () => {
    const { wizard } = setup();
    wizard.setReadyState("paused"); // no window yet: nothing to send to, must not throw
    wizard.focus();
    void wizard.run();
    const w = win();

    wizard.setReadyState("ready");
    wizard.sendPipelineState("recording");
    wizard.focus();

    expect(w.webContents.sent("setup:ready-state")).toEqual([["ready"]]);
    expect(w.webContents.sent("setup:pipeline-state")).toEqual([["recording"]]);
    expect(w.show).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);

    w.destroy();
    wizard.setReadyState("paused");
    wizard.sendPipelineState("idle");
    wizard.focus();
    expect(w.webContents.send).toHaveBeenCalledTimes(2);
    expect(w.show).toHaveBeenCalledTimes(1);
  });
});

describe("setup:get-initial-state", () => {
  it("reports prefs, permissions, free space and a tier as installed only when both of its models are", async () => {
    const { wizard, installed, setPrefs } = setup();
    setPrefs({ setupStep: "tier", setupTierId: "balanced", setupReason: "missing-model", launchAtLogin: false });
    installed.add("whisper-small").add("qwen-1.5b").add("qwen-3b"); // balanced complete; max lacks whisper-large
    void wizard.run();
    wizard.setReadyState("accessibility-off");

    const state = (await ipcMain.invoke("setup:get-initial-state")) as {
      tiers: Array<{ id: string; installed: boolean; sizeBytes: number }>;
    } & Record<string, unknown>;

    expect(state).toMatchObject({
      micPermission: "granted",
      accessibilityPermission: "granted",
      automationPermission: "unknown",
      setupStep: "tier",
      setupTierId: "balanced",
      setupReason: "missing-model",
      launchAtLogin: false,
      freeBytes: 12_345,
      readyState: "accessibility-off",
    });
    expect(state.tiers.map((t) => [t.id, t.installed])).toEqual([
      ["fast", false],
      ["balanced", true],
      ["max", false],
    ]);
    expect(state.tiers.every((t) => t.sizeBytes > 0)).toBe(true);
  });

  it("freeBytes is null when the models directory can't be read, and the permission statuses are live", async () => {
    const { wizard, accessibility } = setup();
    void wizard.run();
    fsMock.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    systemPreferences.getMediaAccessStatus.mockReturnValue("denied");
    accessibility.isTrusted.mockReturnValue(false);

    const state = (await ipcMain.invoke("setup:get-initial-state")) as Record<string, unknown>;

    expect(state).toMatchObject({ freeBytes: null, micPermission: "denied", accessibilityPermission: "denied" });
  });
});

describe("setup preference messages", () => {
  it("save-step accepts only the renderer-savable steps", async () => {
    const { wizard, update } = setup();
    void wizard.run();

    for (const step of ["welcome", "permissions", "tier", "download"]) ipcMain.emit("setup:save-step", { step });
    ipcMain.emit("setup:save-step", { step: "ready" });
    ipcMain.emit("setup:save-step", { step: "bogus" });
    ipcMain.emit("setup:save-step", undefined);

    expect(update.mock.calls.map(([p]) => p)).toEqual([
      { setupStep: "welcome" },
      { setupStep: "permissions" },
      { setupStep: "tier" },
      { setupStep: "download" },
    ]);
  });

  it("save-step drops an unknown tier, keeps a known one and saves null", async () => {
    const { wizard, update } = setup();
    void wizard.run();

    ipcMain.emit("setup:save-step", { step: "tier", tierId: "gigantic" });
    ipcMain.emit("setup:save-step", { step: "tier", tierId: "max" });
    ipcMain.emit("setup:save-step", { step: "tier", tierId: null });
    ipcMain.emit("setup:save-step", { step: "tier", tierId: 3 });

    expect(update.mock.calls.map(([p]) => p)).toEqual([
      { setupStep: "tier" },
      { setupStep: "tier", setupTierId: "max" },
      { setupStep: "tier", setupTierId: null },
      { setupStep: "tier" },
    ]);
  });

  it("save-step is ignored once setup is saved", async () => {
    const { wizard, update } = setup();
    void wizard.run();
    await ipcMain.invoke("setup:start-download", "balanced");
    update.mockClear();

    ipcMain.emit("setup:save-step", { step: "welcome" });

    expect(update).not.toHaveBeenCalled();
  });

  it("a rejected save-step update is swallowed", async () => {
    const { wizard, update } = setup();
    void wizard.run();
    update.mockRejectedValueOnce(new Error("disk full"));
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);

    ipcMain.emit("setup:save-step", { step: "welcome" });
    await settle();
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("set-launch-at-login ignores non-booleans and applies a boolean to the store and to the login item", async () => {
    const { wizard, update } = setup();
    void wizard.run();

    ipcMain.emit("setup:set-launch-at-login", "yes");
    ipcMain.emit("setup:set-launch-at-login", 1);
    expect(update).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();

    ipcMain.emit("setup:set-launch-at-login", false);
    expect(update).toHaveBeenCalledWith({ launchAtLogin: false });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it("set-launch-at-login swallows a throwing setLoginItemSettings and still saves", async () => {
    const { wizard, update } = setup();
    void wizard.run();
    app.setLoginItemSettings.mockImplementation(() => {
      throw new Error("needs approval");
    });

    expect(() => ipcMain.emit("setup:set-launch-at-login", true)).not.toThrow();
    expect(update).toHaveBeenCalledWith({ launchAtLogin: true });
  });
});

describe("permissions and system actions", () => {
  it("request-mic maps the macOS answer", async () => {
    const { wizard } = setup();
    void wizard.run();
    systemPreferences.askForMediaAccess.mockResolvedValueOnce(true);
    await expect(ipcMain.invoke("setup:request-mic")).resolves.toBe("granted");
    systemPreferences.askForMediaAccess.mockResolvedValueOnce(false);
    await expect(ipcMain.invoke("setup:request-mic")).resolves.toBe("denied");
    expect(systemPreferences.askForMediaAccess).toHaveBeenCalledWith("microphone");
  });

  it("request-accessibility asks for trust once and returns the resulting status", async () => {
    const { wizard, accessibility } = setup();
    void wizard.run();
    accessibility.isTrusted.mockReturnValue(false);

    await expect(ipcMain.invoke("setup:request-accessibility")).resolves.toBe("denied");

    expect(accessibility.requestTrust).toHaveBeenCalledTimes(1);
  });

  it("refresh-permissions probes Automation only when asked", async () => {
    const { wizard } = setup();
    void wizard.run();

    await expect(ipcMain.invoke("setup:refresh-permissions")).resolves.toEqual({
      mic: "granted",
      accessibility: "granted",
      automation: null,
    });
    expect(probe.checkAutomationViaProbe).not.toHaveBeenCalled();

    await expect(ipcMain.invoke("setup:refresh-permissions", { automation: true })).resolves.toEqual({
      mic: "granted",
      accessibility: "granted",
      automation: "granted",
    });
    expect(probe.checkAutomationViaProbe).toHaveBeenCalledTimes(1);
  });

  it("open-system-settings maps the three panes and ignores anything else", async () => {
    const { wizard } = setup();
    void wizard.run();

    for (const pane of ["accessibility", "microphone", "automation", "network"]) {
      ipcMain.emit("setup:open-system-settings", pane);
    }

    const base = "x-apple.systempreferences:com.apple.preference.security?";
    expect(shell.openExternal.mock.calls.map(([u]) => u)).toEqual([
      `${base}Privacy_Accessibility`,
      `${base}Privacy_Microphone`,
      `${base}Privacy_Automation`,
    ]);
  });

  it("relaunch schedules app.relaunch + quit on the next tick, not synchronously", async () => {
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    const { wizard } = setup();
    void wizard.run();

    ipcMain.emit("setup:relaunch");
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("setup:start-download", () => {
  it("rejects an unknown tier without downloading anything", async () => {
    const { wizard, download } = setup();
    void wizard.run();

    await ipcMain.invoke("setup:start-download", "gigantic");

    expect(download).not.toHaveBeenCalled();
    expect(win().webContents.sent("setup:download-done")).toEqual([
      [{ ok: false, error: { title: "Unknown quality level", hint: "Choose another one.", retryable: false, code: "unknown-tier" } }],
    ]);
  });

  it("downloads both files, throttles progress (first, <=1 per 100 ms, final 100% of each file) and completes setup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const { wizard, download, update, removeOrphanPartials } = setup();
    const result = wizard.run();
    download.mockImplementation(async (desc, onProgress) => {
      const report = (bytes: number) => onProgress?.({ bytes, total: desc.sizeBytes });
      if (desc.id === WHISPER.id) {
        report(10); // first: passes
        report(20); // same instant: gated
        vi.setSystemTime(1_000_100);
        report(30); // 100 ms later: passes
        report(WHISPER.sizeBytes); // final: always passes
      } else {
        report(5); // 0 ms after the last emit: gated
        report(LLM.sizeBytes); // final
      }
    });

    await ipcMain.invoke("setup:start-download", "balanced");

    expect(win().webContents.sent("setup:download-progress")).toEqual([
      [{ stage: WHISPER.label, bytes: 10, total: WHISPER.sizeBytes, fileIndex: 1, fileCount: 2 }],
      [{ stage: WHISPER.label, bytes: 30, total: WHISPER.sizeBytes, fileIndex: 1, fileCount: 2 }],
      [{ stage: WHISPER.label, bytes: WHISPER.sizeBytes, total: WHISPER.sizeBytes, fileIndex: 1, fileCount: 2 }],
      [{ stage: LLM.label, bytes: LLM.sizeBytes, total: LLM.sizeBytes, fileIndex: 2, fileCount: 2 }],
    ]);
    expect(update).toHaveBeenCalledWith({
      setupComplete: true,
      setupStep: "ready",
      setupReason: null,
      setupTierId: "balanced",
      whisperModelId: "whisper-small",
      llmModelId: "qwen-1.5b",
    });
    expect(removeOrphanPartials).toHaveBeenCalledTimes(1);
    const [keep, all] = removeOrphanPartials.mock.calls[0] ?? [];
    expect(keep?.map((d) => d.id)).toEqual(["whisper-small", "qwen-1.5b"]);
    expect(all).toEqual([...WHISPER_MODELS, ...LLM_MODELS]);
    expect(win().webContents.sent("setup:download-done")).toEqual([[{ ok: true }]]);
    await expect(result).resolves.toBe(true);
    expect(wizard.isOpen()).toBe(true); // the window stays on the "ready" step
  });

  it("skips a file that is already installed, reporting it once at 100%", async () => {
    const { wizard, installed, download } = setup();
    void wizard.run();
    installed.add(WHISPER.id);

    await ipcMain.invoke("setup:start-download", "balanced");

    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0].id).toBe(LLM.id);
    const first = win().webContents.sent("setup:download-progress")[0];
    expect(first).toEqual([
      expect.objectContaining({ bytes: WHISPER.sizeBytes, total: WHISPER.sizeBytes, fileIndex: 1, fileCount: 2 }),
    ]);
  });

  it("a failed download reports a UI-safe error (no raw message, URL or hash) and does not complete setup", async () => {
    const { wizard, download, update, removeOrphanPartials } = setup();
    const result = wizard.run();
    const hash = "a".repeat(64);
    download.mockRejectedValue(new Error(`HTTP 500 fetching https://huggingface.co/secret/model.bin sha ${hash}`));

    await ipcMain.invoke("setup:start-download", "balanced");

    const done = win().webContents.sent("setup:download-done");
    expect(done).toHaveLength(1);
    const payload = done[0]?.[0] as { ok: boolean; error: { title: string; hint: string; retryable: boolean; code: string } };
    expect(payload.ok).toBe(false);
    expect(payload.error.title.length).toBeGreaterThan(0);
    expect(typeof payload.error.retryable).toBe("boolean");
    expect(JSON.stringify(payload)).not.toContain("huggingface");
    expect(JSON.stringify(payload)).not.toContain(hash);
    expect(payload.error.hint).not.toContain("https://");
    expect(update).not.toHaveBeenCalled();
    expect(removeOrphanPartials).not.toHaveBeenCalled();

    // The failure released the slot: a retry is accepted.
    download.mockResolvedValue(undefined);
    await ipcMain.invoke("setup:start-download", "balanced");
    await expect(result).resolves.toBe(true);
  });

  it("ignores a second start while a download runs, and cancel aborts the signal handed to download", async () => {
    const { wizard, download } = setup();
    void wizard.run();
    const hold = deferred();
    let signal: AbortSignal | undefined;
    download.mockImplementation(async (_d, _p, opts) => {
      signal = opts?.signal;
      await hold.promise;
    });

    const first = ipcMain.invoke("setup:start-download", "balanced");
    await settle();
    await ipcMain.invoke("setup:start-download", "balanced");
    expect(download).toHaveBeenCalledTimes(1);

    expect(signal?.aborted).toBe(false);
    ipcMain.emit("setup:cancel-download");
    expect(signal?.aborted).toBe(true);

    hold.resolve();
    await first;
  });

  it("cancel with nothing running is a no-op", async () => {
    const { wizard } = setup();
    void wizard.run();
    expect(() => ipcMain.emit("setup:cancel-download")).not.toThrow();
  });
});
