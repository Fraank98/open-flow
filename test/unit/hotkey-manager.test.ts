import { describe, it, expect, vi, beforeEach } from "vitest";
import { globalShortcut, resetElectronMock } from "../helpers/electron-mock.js";

vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);

import { HotkeyManager } from "../../src/main/hotkey-manager.js";

describe("HotkeyManager", () => {
  let press: () => void;

  beforeEach(() => {
    resetElectronMock();
    globalShortcut.register.mockImplementation((_acc: string, cb: () => void) => {
      press = cb;
      return true;
    });
  });

  function make() {
    const hk = new HotkeyManager({ accelerator: "Alt+Space" });
    const events: string[] = [];
    hk.on("start", () => events.push("start"));
    hk.on("stop", () => events.push("stop"));
    return { hk, events };
  }

  it("registers the accelerator and toggles start/stop on successive presses", () => {
    const { hk, events } = make();
    expect(hk.register()).toEqual({ ok: true });
    expect(globalShortcut.register).toHaveBeenCalledWith("Alt+Space", expect.any(Function));
    expect(hk.isActive()).toBe(false);
    press();
    expect(hk.isActive()).toBe(true);
    press();
    expect(hk.isActive()).toBe(false);
    press();
    expect(events).toEqual(["start", "stop", "start"]);
    expect(hk.isActive()).toBe(true);
  });

  it("returns a reason naming the accelerator when registration fails, and does not mark it registered", () => {
    globalShortcut.register.mockReturnValue(false);
    const { hk } = make();
    expect(hk.register()).toEqual({ ok: false, reason: "Could not register hotkey Alt+Space" });
    hk.unregister();
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
  });

  it("reset() returns to inactive without emitting stop, so the next press is a fresh start", () => {
    const { hk, events } = make();
    hk.register();
    press();
    hk.reset();
    expect(hk.isActive()).toBe(false);
    expect(events).toEqual(["start"]);
    press();
    expect(events).toEqual(["start", "start"]);
  });

  it("unregister() releases the shortcut once, resets the state and is idempotent", () => {
    const { hk } = make();
    hk.register();
    press();
    hk.unregister();
    hk.unregister();
    expect(globalShortcut.unregister).toHaveBeenCalledTimes(1);
    expect(globalShortcut.unregister).toHaveBeenCalledWith("Alt+Space");
    expect(hk.isActive()).toBe(false);
  });

  it("unregister() before register() does nothing", () => {
    const { hk } = make();
    hk.unregister();
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
  });
});
