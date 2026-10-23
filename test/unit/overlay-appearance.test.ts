import { describe, it, expect, vi } from "vitest";
const windows = vi.hoisted(() => ({ instances: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn> }; setBounds: ReturnType<typeof vi.fn> }> }));
vi.mock("electron", () => ({
  screen: { getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 900 } }], getCursorScreenPoint: () => ({ x: 100, y: 100 }) },
  BrowserWindow: class {
    webContents = { send: vi.fn() };
    visible = false;
    dead = false;
    setBounds = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setAlwaysOnTop = vi.fn();
    loadFile = vi.fn(async () => {});
    constructor() { windows.instances.push(this); }
    isDestroyed() { return this.dead; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.dead = true; }
  },
}));
import { OverlayWindow } from "../../src/main/overlay-window.js";

describe("overlay appearance", () => {
  it("delivers saved appearance after loading and changes visible geometry without stealing focus", async () => {
    const overlay = new OverlayWindow();
    overlay.setAppearance("preview", "⌃ Control");
    await overlay.create();
    const win = windows.instances.at(-1)!;
    expect(win.webContents.send).toHaveBeenCalledWith("overlay:appearance", { style: "preview", shortcutLabel: "⌃ Control" });
    overlay.sendState("recording");
    overlay.show();
    expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 420, height: 188 }));
    overlay.setAppearance("minimal", "⌃ Control");
    expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 286, height: 116 }));
    overlay.sendState("paste-failed");
    overlay.setAppearance("compact", "⌃ Control");
    expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 420, height: 124 }));
    overlay.sendState("suggesting");
    overlay.setAppearance("minimal", "⌃ Control");
    expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 480, height: 520 }));
    overlay.hide();
    overlay.sendState("recording");
    overlay.show();
    expect(win.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ width: 286, height: 116 }));
    overlay.destroy();
    expect(() => overlay.setAppearance("preview", "Option")).not.toThrow();
  });
  it("forwards the meter only during recording", async () => {
    const overlay = new OverlayWindow();
    await overlay.create();
    const win = windows.instances.at(-1)!;
    overlay.sendLevel(1);
    expect(win.webContents.send).not.toHaveBeenCalledWith("overlay:level", 1);
    overlay.sendState("recording");
    overlay.sendLevel(.5);
    expect(win.webContents.send).toHaveBeenCalledWith("overlay:level", .5);
    overlay.sendState("transcribing");
    win.webContents.send.mockClear();
    overlay.sendLevel(.8);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
