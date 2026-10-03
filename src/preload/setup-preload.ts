import { contextBridge, ipcRenderer } from "electron";

type SettingsPane = "accessibility" | "microphone" | "automation";
type SetupStepId = "welcome" | "permissions" | "tier" | "download" | "ready";

interface PermissionsSnapshot {
  mic: string;
  accessibility: string;
  automation: string | null;
}

interface TierInfo {
  id: string;
  label: string;
  description: string;
  summary: string;
  transcriptionNote: string;
  recommended: boolean;
  sizeBytes: number;
  ramBytes: number;
  installed: boolean;
  licenseNote: string | null;
}

interface InitialState {
  micPermission: string;
  accessibilityPermission: string;
  automationPermission: string;
  tiers: TierInfo[];
  setupStep: SetupStepId;
  setupTierId: string | null;
  /** Free bytes on the volume that holds the models, or null when unknown. */
  freeBytes: number | null;
  launchAtLogin: boolean;
  /** True when the app finished starting before this window loaded. */
  appReady: boolean;
}

type PipelineViewState = "idle" | "recording" | "transcribing" | "cleaning" | "pasting";

interface DownloadProgress {
  stage: string;
  bytes: number;
  total: number;
  fileIndex: number;
  fileCount: number;
}

interface DownloadResult {
  ok: boolean;
  /** UI-safe text; `code` is "aborted" when the user cancelled. */
  error?: { title: string; hint: string; retryable: boolean; code: string };
}

contextBridge.exposeInMainWorld("openFlowSetup", {
  getInitialState: (): Promise<InitialState> => ipcRenderer.invoke("setup:get-initial-state"),

  requestMicPermission: (): Promise<string> => ipcRenderer.invoke("setup:request-mic"),
  requestAccessibility: (): Promise<string> => ipcRenderer.invoke("setup:request-accessibility"),
  /** `automation` is null unless `{ automation: true }` is passed (the probe can raise a macOS prompt). */
  refreshPermissions: (opts?: { automation?: boolean }): Promise<PermissionsSnapshot> =>
    ipcRenderer.invoke("setup:refresh-permissions", opts),
  openSystemSettings: (pane: SettingsPane): void => ipcRenderer.send("setup:open-system-settings", pane),

  /** Remembers the step (and the chosen quality level) so a closed wizard can resume. */
  saveStep: (p: { step: SetupStepId; tierId?: string | null }): void => ipcRenderer.send("setup:save-step", p),
  setLaunchAtLogin: (enabled: boolean): void => ipcRenderer.send("setup:set-launch-at-login", enabled),

  startDownload: (tierId: string): Promise<void> => ipcRenderer.invoke("setup:start-download", tierId),
  cancelDownload: (): void => ipcRenderer.send("setup:cancel-download"),
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
    const handler = (_e: unknown, payload: DownloadProgress) => cb(payload);
    ipcRenderer.on("setup:download-progress", handler);
    return () => ipcRenderer.removeListener("setup:download-progress", handler);
  },
  onDownloadDone: (cb: (result: DownloadResult) => void): (() => void) => {
    const handler = (_e: unknown, payload: DownloadResult) => cb(payload);
    ipcRenderer.on("setup:download-done", handler);
    return () => ipcRenderer.removeListener("setup:download-done", handler);
  },

  /** The models are loaded and push-to-talk is armed: the user can try dictating elsewhere. */
  onAppReady: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("setup:app-ready", handler);
    return () => ipcRenderer.removeListener("setup:app-ready", handler);
  },
  onPipelineState: (cb: (state: PipelineViewState) => void): (() => void) => {
    const handler = (_e: unknown, state: PipelineViewState) => cb(state);
    ipcRenderer.on("setup:pipeline-state", handler);
    return () => ipcRenderer.removeListener("setup:pipeline-state", handler);
  },

  finish: (): void => ipcRenderer.send("setup:finish"),
});

declare global {
  interface Window {
    openFlowSetup: {
      getInitialState: () => Promise<InitialState>;
      requestMicPermission: () => Promise<string>;
      requestAccessibility: () => Promise<string>;
      refreshPermissions: (opts?: { automation?: boolean }) => Promise<PermissionsSnapshot>;
      openSystemSettings: (pane: SettingsPane) => void;
      saveStep: (p: { step: SetupStepId; tierId?: string | null }) => void;
      setLaunchAtLogin: (enabled: boolean) => void;
      startDownload: (tierId: string) => Promise<void>;
      cancelDownload: () => void;
      onDownloadProgress: (cb: (p: DownloadProgress) => void) => () => void;
      onDownloadDone: (cb: (result: DownloadResult) => void) => () => void;
      onAppReady: (cb: () => void) => () => void;
      onPipelineState: (cb: (state: PipelineViewState) => void) => () => void;
      finish: () => void;
    };
  }
}

export {};
