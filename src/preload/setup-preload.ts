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
  /** Why setup reopened by itself, e.g. "missing-model"; null on a normal run. */
  setupReason: string | null;
  /** Free bytes on the volume that holds the models, or null when unknown. */
  freeBytes: number | null;
  launchAtLogin: boolean;
  /** Where the app stands, for the final step (it may have settled before this window loaded). */
  readyState: ReadyState;
}

type ReadyState = "starting" | "ready" | "accessibility-off" | "relaunch-needed" | "paused";
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

  /** The app's state for the final step: armed (try dictating elsewhere), or why it isn't. */
  onReadyState: (cb: (state: ReadyState) => void): (() => void) => {
    const handler = (_e: unknown, state: ReadyState) => cb(state);
    ipcRenderer.on("setup:ready-state", handler);
    return () => ipcRenderer.removeListener("setup:ready-state", handler);
  },
  relaunch: (): void => ipcRenderer.send("setup:relaunch"),
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
      onReadyState: (cb: (state: ReadyState) => void) => () => void;
      relaunch: () => void;
      onPipelineState: (cb: (state: PipelineViewState) => void) => () => void;
      finish: () => void;
    };
  }
}

export {};
