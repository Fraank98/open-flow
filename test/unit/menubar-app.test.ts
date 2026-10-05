import { describe, it, expect, vi, beforeEach } from "vitest";
import { Tray, Menu, app, nativeImage, resetElectronMock } from "../helpers/electron-mock.js";

vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);

import { MenubarApp, type MenubarCallbacks } from "../../src/main/menubar-app.js";

type Item = { label?: string; type?: string; enabled?: boolean; click?: () => void };

describe("MenubarApp", () => {
  let cb: { [K in keyof MenubarCallbacks]: ReturnType<typeof vi.fn<MenubarCallbacks[K]>> };

  beforeEach(() => {
    resetElectronMock();
    app.dock.hide.mockClear();
    Menu.buildFromTemplate.mockImplementation((template: unknown[]) => ({ template }));
    nativeImage.createFromPath.mockImplementation((_p: string) => ({ setTemplateImage: vi.fn() }));
    cb = {
      onToggleEnabled: vi.fn<() => void>(),
      onOpenSettings: vi.fn<() => void>(),
      onCheckPermissions: vi.fn<() => void>(),
      onOpenLogs: vi.fn<() => void>(),
      onRelaunch: vi.fn<() => void>(),
      onQuit: vi.fn<() => void>(),
    };
  });

  const make = () => new MenubarApp(cb, { version: "1.2.3" });
  const lastMenu = (): Item[] => {
    const tray = Tray.instances[0]!;
    const menu = tray.setContextMenu.mock.calls.at(-1)![0] as { template: Item[] };
    return menu.template;
  };
  const labelled = (label: string): Item => lastMenu().find((i) => i.label === label)!;

  it("create() builds the template-image tray, sets the tooltip, renders the menu and hides the dock", () => {
    const m = make();
    m.create();
    expect(Tray.instances).toHaveLength(1);
    const iconPath = nativeImage.createFromPath.mock.calls[0]![0];
    expect(iconPath.endsWith("resources/icons/tray-template.png")).toBe(true);
    const icon = nativeImage.createFromPath.mock.results[0]!.value as { setTemplateImage: ReturnType<typeof vi.fn> };
    expect(icon.setTemplateImage).toHaveBeenCalledWith(true);
    expect(Tray.instances[0]!.setToolTip).toHaveBeenCalledWith("open-flow");
    expect(lastMenu()[0]).toEqual({ label: "open-flow 1.2.3 — Starting…", enabled: false });
    expect(app.dock.hide).toHaveBeenCalledTimes(1);
  });

  it("setStatus() and setPermissionHint() rebuild the menu", () => {
    const m = make();
    m.create();
    m.setStatus("Ready");
    expect(lastMenu()[0]!.label).toBe("open-flow 1.2.3 — Ready");
    expect(lastMenu().some((i) => i.label === "Accessibility needed")).toBe(false);
    m.setPermissionHint("Accessibility needed");
    expect(lastMenu()[1]).toEqual({ label: "Accessibility needed", enabled: false });
    m.setPermissionHint(null);
    expect(lastMenu().some((i) => i.label === "Accessibility needed")).toBe(false);
  });

  it("setStatus() before create() is stored and does not throw", () => {
    const m = make();
    expect(() => m.setStatus("Ready")).not.toThrow();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    m.create();
    expect(lastMenu()[0]!.label).toBe("open-flow 1.2.3 — Ready");
  });

  it("the pause item flips isEnabled(), calls onToggleEnabled and shows 'Paused' / 'Resume dictation'", () => {
    const m = make();
    m.create();
    m.setStatus("Ready");
    expect(m.isEnabled()).toBe(true);
    labelled("Pause dictation").click!();
    expect(m.isEnabled()).toBe(false);
    expect(cb.onToggleEnabled).toHaveBeenCalledTimes(1);
    expect(lastMenu()[0]!.label).toBe("open-flow 1.2.3 — Paused");
    labelled("Resume dictation").click!();
    expect(m.isEnabled()).toBe(true);
    expect(cb.onToggleEnabled).toHaveBeenCalledTimes(2);
    expect(lastMenu()[0]!.label).toBe("open-flow 1.2.3 — Ready");
  });

  it("every menu item is wired to its callback", () => {
    make().create();
    labelled("Settings…").click!();
    labelled("Check permissions…").click!();
    labelled("Open Logs").click!();
    labelled("Relaunch open-flow").click!();
    labelled("Quit open-flow").click!();
    expect(cb.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(cb.onCheckPermissions).toHaveBeenCalledTimes(1);
    expect(cb.onOpenLogs).toHaveBeenCalledTimes(1);
    expect(cb.onRelaunch).toHaveBeenCalledTimes(1);
    expect(cb.onQuit).toHaveBeenCalledTimes(1);
    expect(cb.onToggleEnabled).not.toHaveBeenCalled();
  });

  it("destroy() destroys the tray once and later updates are ignored", () => {
    const m = make();
    m.create();
    m.destroy();
    m.destroy();
    const tray = Tray.instances[0]!;
    expect(tray.destroy).toHaveBeenCalledTimes(1);
    const calls = tray.setContextMenu.mock.calls.length;
    m.setStatus("Ready");
    expect(tray.setContextMenu.mock.calls.length).toBe(calls);
  });
});
