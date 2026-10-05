import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelManager } from "../../src/main/model-manager.js";
import { DEFAULT_PREFS, PreferencesStore, type Preferences } from "../../src/main/preferences-store.js";
import { PreferencesWindow, type ReplyUiStatus } from "../../src/main/preferences-window.js";
import { DownloadTracker } from "../../src/main/utils/download-tracker.js";
import { REPLY_MODELS, replyCards } from "../../src/main/model-catalog.js";
import { app, dialog, ipcMain, resetElectronMock, shell, FakeBrowserWindow, type FakeWebContents } from "../helpers/electron-mock.js";
import { deferred } from "../helpers/deferred.js";

vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);

// The bundle lookups shell out to mdls/mdfind/plutil.
const bundle = vi.hoisted(() => ({
  readBundleId: vi.fn(async (_appPath: string, _exec: unknown): Promise<string | null> => null),
  findAppPathByBundleId: vi.fn(async (_id: string, _exec: unknown): Promise<string | null> => null),
}));
vi.mock("../../src/main/utils/app-bundle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/main/utils/app-bundle.js")>()),
  readBundleId: bundle.readBundleId,
  findAppPathByBundleId: bundle.findAppPathByBundleId,
}));

const PROJECT_URL = "https://github.com/Fraank98/open-flow";
const WHISPER_ID = "whisper-small";

/** Lets fire-and-forget promise chains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup() {
  const modelManager = new ModelManager();
  const installed = new Set<string>();
  vi.spyOn(modelManager, "isInstalled").mockImplementation(async (d) => installed.has(d.id));
  const download = vi.spyOn(modelManager, "download").mockImplementation(async () => undefined);
  const deleteModel = vi.spyOn(modelManager, "deleteModel").mockResolvedValue(undefined);

  const preferencesStore = new PreferencesStore("/nonexistent/prefs.json");
  let prefs: Preferences = { ...DEFAULT_PREFS };
  const load = vi.spyOn(preferencesStore, "load").mockImplementation(async () => ({ ...prefs }));
  const update = vi.spyOn(preferencesStore, "update").mockImplementation(async (patch) => {
    prefs = { ...prefs, ...patch };
    return { ...prefs };
  });

  const replyStatusValue: ReplyUiStatus = {
    serverState: "off",
    serverError: null,
    hotkeyRegistered: true,
    nativeOk: true,
    lastBlockedBundleId: null,
    booting: false,
  };
  const deps = {
    modelManager,
    preferencesStore,
    downloads: new DownloadTracker(),
    replyStatus: vi.fn(() => replyStatusValue),
    replyRetry: vi.fn(async () => undefined),
    restartStatus: vi.fn(async () => ["language"]),
    permissionsStatus: vi.fn(async (_probe: boolean) => ({ mic: "granted", accessibility: "granted", automation: "unknown" }) as const),
    logDir: "/tmp/open-flow-logs",
    version: "9.9.9",
  };
  const prefsWindow = new PreferencesWindow(deps);
  return { prefsWindow, deps, installed, download, deleteModel, load, update, replyStatusValue, setPrefs: (p: Partial<Preferences>) => (prefs = { ...prefs, ...p }) };
}

function win(index = 0): FakeBrowserWindow {
  const w = FakeBrowserWindow.instances[index];
  if (!w) throw new Error("no window was created");
  return w;
}

/** Fires an `ipcMain.on` listener as if `sender` had sent it. */
function sendFrom(sender: unknown, channel: string, ...args: unknown[]): void {
  for (const fn of ipcMain.listeners.get(channel) ?? []) fn({ sender }, ...args);
}

function keyEvent(over: Partial<{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }> = {}) {
  return { type: "keyDown", key: "q", meta: true, control: false, shift: false, alt: false, ...over };
}

beforeEach(() => {
  resetElectronMock();
  bundle.readBundleId.mockReset().mockResolvedValue(null);
  bundle.findAppPathByBundleId.mockReset().mockResolvedValue(null);
  vi.stubEnv("OPEN_FLOW_MODELS_DIR", "/tmp/open-flow-models");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PreferencesWindow.open", () => {
  it("creates the window on the first call, loads the page on the requested tab and shows it when ready", async () => {
    const { prefsWindow } = setup();

    await prefsWindow.open("models");

    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(win().loadFile).toHaveBeenCalledWith(expect.stringMatching(/preferences\.html$/), { hash: "models" });
    expect(win().show).not.toHaveBeenCalled();
    win().emit("ready-to-show");
    expect(win().show).toHaveBeenCalledTimes(1);
  });

  it("a second call reuses the window: focuses, restores when minimised, and sends the tab", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    win().minimized = true;

    await prefsWindow.open("advanced");

    expect(FakeBrowserWindow.instances).toHaveLength(1);
    expect(win().restore).toHaveBeenCalledTimes(1);
    expect(win().focus).toHaveBeenCalledTimes(1);
    expect(win().webContents.sent("prefs:show-tab")).toEqual([["advanced"]]);

    await prefsWindow.open(); // no tab: nothing sent, not minimised: no restore
    expect(win().webContents.sent("prefs:show-tab")).toHaveLength(1);
    expect(win().restore).toHaveBeenCalledTimes(1);
  });

  it("after the window is closed a new one is created and the recorder state starts clean", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    sendFrom(win().webContents, "prefs:recorder-active", true);
    win().destroy();

    await prefsWindow.open();

    expect(FakeBrowserWindow.instances).toHaveLength(2);
    const event = { preventDefault: vi.fn() };
    win(1).webContents.emit("before-input-event", event, keyEvent());
    expect(event.preventDefault).not.toHaveBeenCalled();
    // Handlers were registered once, not once per window.
    expect(ipcMain.handle.mock.calls.filter(([c]) => c === "prefs:load")).toHaveLength(1);
  });
});

describe("shortcut recorder (reserved keys)", () => {
  async function opened() {
    const ctx = setup();
    await ctx.prefsWindow.open();
    return { ...ctx, wc: win().webContents as FakeWebContents };
  }

  it("swallows a reserved keyDown while the recorder is active and tells the renderer", async () => {
    const { wc } = await opened();
    sendFrom(wc, "prefs:recorder-active", true);
    const event = { preventDefault: vi.fn() };

    wc.emit("before-input-event", event, keyEvent({ key: "q" }));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(wc.sent("prefs:reserved-key")).toEqual([[]]);
  });

  it.each([
    ["recorder inactive", false, keyEvent()],
    ["keyUp", true, keyEvent({ type: "keyUp" })],
    ["non-reserved key", true, keyEvent({ key: "a" })],
    ["reserved key with Shift", true, keyEvent({ shift: true })],
  ])("leaves the event alone: %s", async (_name, active, input) => {
    const { wc } = await opened();
    if (active) sendFrom(wc, "prefs:recorder-active", true);
    const event = { preventDefault: vi.fn() };

    wc.emit("before-input-event", event, input);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("honours recorder-active only from the window's own webContents, and only for `true`", async () => {
    const { wc } = await opened();
    const event = { preventDefault: vi.fn() };

    sendFrom({ foreign: true }, "prefs:recorder-active", true);
    wc.emit("before-input-event", event, keyEvent());
    expect(event.preventDefault).not.toHaveBeenCalled();

    sendFrom(wc, "prefs:recorder-active", "true");
    wc.emit("before-input-event", event, keyEvent());
    expect(event.preventDefault).not.toHaveBeenCalled();

    sendFrom(wc, "prefs:recorder-active", true);
    wc.emit("before-input-event", event, keyEvent());
    expect(event.preventDefault).toHaveBeenCalledTimes(1);

    sendFrom(wc, "prefs:recorder-active", false);
    wc.emit("before-input-event", event, keyEvent());
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("prefs:update", () => {
  it("passes the patch through sanitizePrefsPatch: unknown fields and unsupported languages never reach the store", async () => {
    const { prefsWindow, update } = setup();
    await prefsWindow.open();

    await ipcMain.invoke("prefs:update", {
      debugLogging: true,
      language: "klingon",
      setupComplete: true,
      hotkeyAccelerator: "Hold Control",
      whisperModelId: "no-such-model",
      evil: 1,
    });

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ debugLogging: true });

    await ipcMain.invoke("prefs:update", { language: "it" });
    expect(update).toHaveBeenLastCalledWith({ language: "it" });
    await ipcMain.invoke("prefs:update", "not an object");
    expect(update).toHaveBeenLastCalledWith({});
  });

  it("applies launchAtLogin only when it differs from the current login item, and swallows a throwing setter", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();

    app.getLoginItemSettings.mockReturnValue({ openAtLogin: false });
    await ipcMain.invoke("prefs:update", { launchAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });

    app.setLoginItemSettings.mockClear();
    app.getLoginItemSettings.mockReturnValue({ openAtLogin: true });
    await ipcMain.invoke("prefs:update", { launchAtLogin: true });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();

    app.getLoginItemSettings.mockReturnValue({ openAtLogin: false });
    app.setLoginItemSettings.mockImplementation(() => {
      throw new Error("needs approval");
    });
    await expect(ipcMain.invoke("prefs:update", { launchAtLogin: true })).resolves.toMatchObject({ launchAtLogin: true });

    // Not touched at all when the patch has no launchAtLogin.
    app.getLoginItemSettings.mockClear();
    await ipcMain.invoke("prefs:update", { debugLogging: true });
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("calls every onSaved listener with the saved prefs; a throwing one does not fail the save or starve the rest", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    const bad = vi.fn(() => {
      throw new Error("listener bug");
    });
    const good = vi.fn();
    prefsWindow.onSaved(bad);
    prefsWindow.onSaved(good);

    const saved = (await ipcMain.invoke("prefs:update", { spokenPunctuation: true })) as Preferences;

    expect(saved.spokenPunctuation).toBe(true);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith(saved);
  });
});

describe("pass-through channels", () => {
  it("forwards load, restart status, reply status/retry, permissions and app info to the injected deps", async () => {
    const { prefsWindow, deps, replyStatusValue } = setup();
    await prefsWindow.open();

    await expect(ipcMain.invoke("prefs:load")).resolves.toMatchObject({ language: "auto" });
    await expect(ipcMain.invoke("prefs:restart-status")).resolves.toEqual({ fields: ["language"] });
    await expect(ipcMain.invoke("prefs:reply-status")).resolves.toBe(replyStatusValue);
    await ipcMain.invoke("prefs:retry-reply");
    expect(deps.replyRetry).toHaveBeenCalledTimes(1);
    await ipcMain.invoke("prefs:permissions-status", { automation: true });
    await ipcMain.invoke("prefs:permissions-status", { automation: "yes" });
    await ipcMain.invoke("prefs:permissions-status");
    expect(deps.permissionsStatus.mock.calls.map(([probe]) => probe)).toEqual([true, false, false]);
    await expect(ipcMain.invoke("prefs:app-info")).resolves.toEqual({ version: "9.9.9" });
    await expect(ipcMain.invoke("prefs:validate-reply-hotkey", "Alt+X")).resolves.toMatchObject({ ok: false });
  });
});

describe("prefs:list-models", () => {
  it("describes whisper, llm and reply cards, with downloads in flight reflected from the tracker", async () => {
    const { prefsWindow, deps, installed, download } = setup();
    await prefsWindow.open();
    installed.add("qwen-1.5b");
    const hold = deferred();
    download.mockImplementation(async (_d, onProgress) => {
      onProgress?.({ bytes: 10, total: 100 });
      await hold.promise;
    });
    const running = ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID });
    await settle();
    expect(deps.downloads.isActive(WHISPER_ID)).toBe(true);

    const list = (await ipcMain.invoke("prefs:list-models")) as {
      whisper: Array<{ id: string; downloading: boolean; progress: unknown; installed: boolean }>;
      llm: Array<{ id: string; installed: boolean; downloading: boolean; progress: unknown }>;
      reply: Array<{ id: string; tierId: string; details: unknown; label: string }>;
      languages: unknown[];
    };

    const whisper = list.whisper.find((m) => m.id === WHISPER_ID);
    expect(whisper).toMatchObject({ downloading: true, progress: { bytes: 10, total: 100 }, installed: false });
    expect(list.whisper.filter((m) => m.downloading)).toHaveLength(1);
    expect(list.llm.find((m) => m.id === "qwen-1.5b")).toMatchObject({ installed: true, downloading: false, progress: null });
    const cards = replyCards();
    expect(list.reply.map((c) => [c.id, c.tierId, c.label])).toEqual(cards.map((c) => [c.id, c.tierId, c.label]));
    expect(list.reply.every((c) => c.details !== undefined)).toBe(true);
    expect(list.languages.length).toBeGreaterThan(0);

    hold.resolve();
    await running;
  });
});

describe("prefs:download-model", () => {
  it("rejects an unknown model", async () => {
    const { prefsWindow, download } = setup();
    await prefsWindow.open();

    await expect(ipcMain.invoke("prefs:download-model", { kind: "llm", id: "nope" })).rejects.toThrow("Unknown model: llm/nope");
    await expect(ipcMain.invoke("prefs:download-model", { kind: "whisper", id: "qwen-1.5b" })).rejects.toThrow("Unknown model");
    expect(download).not.toHaveBeenCalled();
  });

  it("returns without downloading when the model is installed and nothing is running", async () => {
    const { prefsWindow, installed, download } = setup();
    await prefsWindow.open();
    installed.add(WHISPER_ID);

    await expect(ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID })).resolves.toBeUndefined();

    expect(download).not.toHaveBeenCalled();
  });

  it("re-attaches to a download in flight: no second download, and the caller waits for the real end", async () => {
    const { prefsWindow, installed, download } = setup();
    await prefsWindow.open();
    const hold = deferred();
    download.mockImplementation(async () => {
      await hold.promise;
    });
    const first = ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID });
    await settle();
    // The file may even look installed (size matches while the tail is still being verified):
    // an active download must still win over the installed check.
    installed.add(WHISPER_ID);

    let secondDone = false;
    const second = ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID }).then(() => {
      secondDone = true;
    });
    await settle();
    expect(secondDone).toBe(false);
    expect(download).toHaveBeenCalledTimes(1);

    hold.resolve();
    await Promise.all([first, second]);
    expect(secondDone).toBe(true);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("turns a failure into UI-safe text through downloadErrorText: no URL or hash reaches the renderer", async () => {
    const { prefsWindow, download } = setup();
    await prefsWindow.open();
    const hash = "b".repeat(64);
    download.mockRejectedValue(new Error(`HTTP 500 fetching https://huggingface.co/x/model.bin sha ${hash}`));

    const error = await ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain("huggingface");
    expect(message).not.toContain(hash);
    expect(message.length).toBeGreaterThan(0);
  });

  it("sends progress to the window through a per-model gate, which is dropped at the final event", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000_000);
    const { prefsWindow, download } = setup();
    await prefsWindow.open();
    download.mockImplementationOnce(async (_d, onProgress) => {
      onProgress?.({ bytes: 10, total: 100 }); // first: passes
      onProgress?.({ bytes: 20, total: 100 }); // same instant: gated
      vi.setSystemTime(2_000_100);
      onProgress?.({ bytes: 30, total: 100 }); // 100 ms later: passes
      onProgress?.({ bytes: 100, total: 100 }); // final: always passes, gate dropped
    });
    await ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID });

    expect(win().webContents.sent("prefs:download-progress")).toEqual([
      [{ id: WHISPER_ID, bytes: 10, total: 100 }],
      [{ id: WHISPER_ID, bytes: 30, total: 100 }],
      [{ id: WHISPER_ID, bytes: 100, total: 100 }],
    ]);

    // A fresh download starts with a fresh gate: its first event passes even at the same instant.
    download.mockImplementationOnce(async (_d, onProgress) => {
      onProgress?.({ bytes: 5, total: 100 });
    });
    await ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID });
    expect(win().webContents.sent("prefs:download-progress").at(-1)).toEqual([{ id: WHISPER_ID, bytes: 5, total: 100 }]);
  });

  it("cancel aborts the signal handed to download; a non-string id is ignored", async () => {
    const { prefsWindow, download } = setup();
    await prefsWindow.open();
    const hold = deferred();
    let signal: AbortSignal | undefined;
    download.mockImplementation(async (_d, _p, opts) => {
      signal = opts?.signal;
      await hold.promise;
    });
    const running = ipcMain.invoke("prefs:download-model", { kind: "whisper", id: WHISPER_ID });
    await settle();

    ipcMain.emit("prefs:cancel-download", 42);
    ipcMain.emit("prefs:cancel-download", { id: WHISPER_ID });
    expect(signal?.aborted).toBe(false);
    ipcMain.emit("prefs:cancel-download", WHISPER_ID);
    expect(signal?.aborted).toBe(true);

    hold.resolve();
    await running;
  });

  it("downloads reply models too", async () => {
    const { prefsWindow, download } = setup();
    await prefsWindow.open();
    const reply = REPLY_MODELS[0];
    expect(reply).toBeDefined();

    await ipcMain.invoke("prefs:download-model", { kind: "reply", id: reply!.id });

    expect(download.mock.calls[0]?.[0].id).toBe(reply!.id);
  });
});

describe("prefs:delete-model", () => {
  it("refuses the active model and a model that is downloading, deletes anything else", async () => {
    const { prefsWindow, download, deleteModel, setPrefs } = setup();
    await prefsWindow.open();
    setPrefs({ whisperModelId: WHISPER_ID, llmModelId: "qwen-1.5b" });

    await expect(ipcMain.invoke("prefs:delete-model", { kind: "whisper", id: WHISPER_ID })).rejects.toThrow(
      "Can't delete the active model",
    );
    await expect(ipcMain.invoke("prefs:delete-model", { kind: "llm", id: "qwen-1.5b" })).rejects.toThrow("Can't delete the active model");
    await expect(ipcMain.invoke("prefs:delete-model", { kind: "llm", id: "nope" })).rejects.toThrow("Unknown model");
    expect(deleteModel).not.toHaveBeenCalled();

    const hold = deferred();
    download.mockImplementation(async () => {
      await hold.promise;
    });
    const running = ipcMain.invoke("prefs:download-model", { kind: "llm", id: "qwen-0.5b" });
    await settle();
    await expect(ipcMain.invoke("prefs:delete-model", { kind: "llm", id: "qwen-0.5b" })).rejects.toThrow("This model is downloading");
    expect(deleteModel).not.toHaveBeenCalled();
    hold.resolve();
    await running;

    await ipcMain.invoke("prefs:delete-model", { kind: "llm", id: "qwen-0.5b" });
    expect(deleteModel).toHaveBeenCalledTimes(1);
    expect(deleteModel.mock.calls[0]?.[0].id).toBe("qwen-0.5b");
  });

  it("the active reply model is protected too", async () => {
    const { prefsWindow, setPrefs } = setup();
    await prefsWindow.open();
    const reply = REPLY_MODELS[0];
    setPrefs({ replyModelId: reply!.id });

    await expect(ipcMain.invoke("prefs:delete-model", { kind: "reply", id: reply!.id })).rejects.toThrow("Can't delete the active model");
  });
});

describe("opening things outside the app", () => {
  it("open-external opens only the project page", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();

    for (const url of [
      "https://example.com",
      `${PROJECT_URL}/`,
      `${PROJECT_URL}.evil.com`,
      "file:///etc/passwd",
      `${PROJECT_URL}?x=1`,
      42,
      undefined,
    ]) {
      ipcMain.emit("prefs:open-external", url);
    }
    expect(shell.openExternal).not.toHaveBeenCalled();

    ipcMain.emit("prefs:open-external", PROJECT_URL);
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
    expect(shell.openExternal).toHaveBeenCalledWith(PROJECT_URL);
  });

  it("open-system-settings maps the three panes and ignores anything else", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();

    for (const pane of ["accessibility", "microphone", "automation", "network", 7, undefined]) {
      ipcMain.emit("prefs:open-system-settings", pane);
    }

    const base = "x-apple.systempreferences:com.apple.preference.security?";
    expect(shell.openExternal.mock.calls.map(([u]) => u)).toEqual([
      `${base}Privacy_Accessibility`,
      `${base}Privacy_Microphone`,
      `${base}Privacy_Automation`,
    ]);
  });

  it("open-logs and reveal-models open the log and models folders", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();

    ipcMain.emit("prefs:open-logs");
    ipcMain.emit("prefs:reveal-models");

    expect(shell.openPath.mock.calls.map(([p]) => p)).toEqual(["/tmp/open-flow-logs", "/tmp/open-flow-models"]);
  });
});

describe("relaunch and reset setup", () => {
  it("prefs:relaunch schedules relaunch + quit on the next tick", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    vi.useFakeTimers({ toFake: ["setImmediate"] });

    ipcMain.emit("prefs:relaunch");
    expect(app.relaunch).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it("reset-setup: Cancel changes nothing", async () => {
    const { prefsWindow, update } = setup();
    await prefsWindow.open();
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });

    await expect(ipcMain.invoke("prefs:reset-setup")).resolves.toBe(false);

    expect(dialog.showMessageBox).toHaveBeenCalledWith(win(), expect.objectContaining({ message: "Run setup again?" }));
    expect(update).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("reset-setup: confirming resets setup to the welcome step and relaunches", async () => {
    const { prefsWindow, update } = setup();
    await prefsWindow.open();
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(ipcMain.invoke("prefs:reset-setup")).resolves.toBe(true);

    expect(update).toHaveBeenCalledWith({ setupComplete: false, setupStep: "welcome", setupReason: null });
    expect(app.relaunch).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(app.relaunch).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});

describe("app picker", () => {
  it("pick-app returns null when the dialog is cancelled or empty", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();

    await expect(ipcMain.invoke("prefs:pick-app")).resolves.toBeNull(); // default mock: canceled
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    await expect(ipcMain.invoke("prefs:pick-app")).resolves.toBeNull();
    expect(bundle.readBundleId).not.toHaveBeenCalled();
  });

  it("pick-app reads the bundle id, name and icon of the chosen app", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/Applications/Google Chrome.app"] });
    bundle.readBundleId.mockResolvedValueOnce("com.google.Chrome");

    await expect(ipcMain.invoke("prefs:pick-app")).resolves.toEqual({
      bundleId: "com.google.Chrome",
      name: "Google Chrome",
      icon: "data:image/png;base64,ICON",
    });
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(win(), expect.objectContaining({ defaultPath: "/Applications" }));
  });

  it("pick-app yields a null icon when the icon can't be read, and throws when the bundle id is unreadable", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/Applications/Foo.app"] });
    bundle.readBundleId.mockResolvedValueOnce("com.foo.Foo");
    app.getFileIcon.mockRejectedValueOnce(new Error("no icon"));

    await expect(ipcMain.invoke("prefs:pick-app")).resolves.toEqual({ bundleId: "com.foo.Foo", name: "Foo", icon: null });

    bundle.readBundleId.mockResolvedValueOnce(null);
    await expect(ipcMain.invoke("prefs:pick-app")).rejects.toThrow("Couldn't read this app's identifier");
  });

  it("resolve-apps de-duplicates, drops non-bundle-ids and caps the list at 100", async () => {
    const { prefsWindow } = setup();
    await prefsWindow.open();
    bundle.findAppPathByBundleId.mockImplementation(async (id: string) => (id === "com.apple.mail" ? "/Applications/Mail.app" : null));

    const result = await ipcMain.invoke("prefs:resolve-apps", [
      "com.apple.mail",
      "com.apple.mail",
      "not a bundle id; rm -rf /",
      42,
      "com.unknown.App",
    ]);

    expect(result).toEqual([
      { bundleId: "com.apple.mail", name: "Mail", icon: "data:image/png;base64,ICON" },
      { bundleId: "com.unknown.App", name: null, icon: null },
    ]);

    const many = Array.from({ length: 150 }, (_, i) => `com.example.app${i}`);
    const capped = (await ipcMain.invoke("prefs:resolve-apps", many)) as unknown[];
    expect(capped).toHaveLength(100);

    await expect(ipcMain.invoke("prefs:resolve-apps", "com.apple.mail")).resolves.toEqual([]);
  });
});
