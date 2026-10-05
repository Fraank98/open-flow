import { EventEmitter } from "node:events";
import { vi } from "vitest";

/**
 * In-memory stand-in for the `electron` module. Use it from a test with:
 *
 *   vi.mock("electron", async () => (await import("../helpers/electron-mock.js")).electron);
 *
 * (the factory is hoisted, so the fakes must come from a module, not from
 * top-level test variables). Call `resetElectronMock()` in `beforeEach`.
 */

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
type Listener = (event: { sender: unknown }, ...args: unknown[]) => void;

export class FakeWebContents extends EventEmitter {
  send = vi.fn<(channel: string, ...args: unknown[]) => void>();
  sent(channel: string): unknown[][] {
    return this.send.mock.calls.filter(([c]) => c === channel).map(([, ...rest]) => rest);
  }
}

export class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  destroyed = false;
  minimized = false;
  readonly options: unknown;
  show = vi.fn();
  focus = vi.fn();
  restore = vi.fn(() => {
    this.minimized = false;
  });
  setVisibleOnAllWorkspaces = vi.fn();
  loadFile = vi.fn(async (_path: string, _opts?: unknown) => undefined);
  constructor(options?: unknown) {
    super();
    this.options = options;
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  /** close() fires "close" (cancellable); if nobody prevents it the window is destroyed. */
  close(): void {
    let prevented = false;
    this.emit("close", { preventDefault: () => (prevented = true) });
    if (!prevented) this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

const handlers = new Map<string, Handler>();
const listeners = new Map<string, Listener[]>();

export const ipcMain = {
  handlers,
  listeners,
  handle: vi.fn((channel: string, fn: Handler) => {
    handlers.set(channel, fn);
  }),
  removeHandler: vi.fn((channel: string) => {
    handlers.delete(channel);
  }),
  on: vi.fn((channel: string, fn: Listener) => {
    listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
  }),
  removeAllListeners: vi.fn((channel: string) => {
    listeners.delete(channel);
  }),
  /** Test hook: call an `ipcMain.handle` handler as the renderer would. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`no handler registered for ${channel}`);
    return fn({ sender: null }, ...args);
  },
  /** Test hook: fire `ipcMain.on` listeners as the renderer's `send` would. */
  emit(channel: string, ...args: unknown[]): void {
    for (const fn of listeners.get(channel) ?? []) fn({ sender: null }, ...args);
  },
};

export const app = {
  getVersion: vi.fn(() => "0.0.0-test"),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  relaunch: vi.fn(),
  quit: vi.fn(),
  dock: { hide: vi.fn(), show: vi.fn() },
};

export const dialog = {
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0 })),
  showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] as string[] })),
};

export const nativeTheme = { shouldUseDarkColors: false };

export const shell = {
  openExternal: vi.fn(async (_url: string) => undefined),
  openPath: vi.fn(async (_path: string) => ""),
  showItemInFolder: vi.fn(),
};

export const systemPreferences = {
  getMediaAccessStatus: vi.fn((_kind: string) => "granted"),
  askForMediaAccess: vi.fn(async (_kind: string) => true),
  isTrustedAccessibilityClient: vi.fn((_prompt: boolean) => true),
};

export const globalShortcut = {
  register: vi.fn((_accelerator: string, _cb: () => void) => true),
  unregister: vi.fn((_accelerator: string) => undefined),
};

export const clipboard = {
  readText: vi.fn(async () => ""),
  writeText: vi.fn(async (_text: string) => undefined),
};

export class Tray {
  static instances: Tray[] = [];
  setToolTip = vi.fn();
  setContextMenu = vi.fn();
  destroy = vi.fn();
  constructor(readonly icon: unknown) {
    Tray.instances.push(this);
  }
}

export const Menu = {
  buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
};

export const nativeImage = {
  createFromPath: vi.fn((_path: string) => ({ setTemplateImage: vi.fn() })),
};

export const electron = {
  app,
  BrowserWindow: FakeBrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  systemPreferences,
  globalShortcut,
  clipboard,
  Tray,
  Menu,
  nativeImage,
};

/** Reset recorded calls and implementations, registered handlers and created windows between tests. */
export function resetElectronMock(): void {
  handlers.clear();
  listeners.clear();
  FakeBrowserWindow.instances.length = 0;
  Tray.instances.length = 0;
  for (const group of [ipcMain, app, dialog, shell, systemPreferences, globalShortcut, clipboard, Menu, nativeImage]) {
    for (const value of Object.values(group)) {
      if (vi.isMockFunction(value)) value.mockReset();
    }
  }
}
