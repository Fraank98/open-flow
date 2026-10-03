import { contextBridge, ipcRenderer } from "electron";

type SettingsPane = "accessibility" | "microphone" | "automation";
interface PermissionsSnapshot {
  mic: string;
  accessibility: string;
  automation: string | null;
}

contextBridge.exposeInMainWorld("openFlowSetup", {
  getInitialState: (): Promise<{
    micPermission: string;
    accessibilityPermission: string;
    automationPermission: string;
    tiers: Array<{
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
    }>;
  }> => ipcRenderer.invoke("setup:get-initial-state"),

  requestMicPermission: (): Promise<string> => ipcRenderer.invoke("setup:request-mic"),
  requestAccessibility: (): Promise<string> => ipcRenderer.invoke("setup:request-accessibility"),
  /** `automation` is null unless `{ automation: true }` is passed (the probe can raise a macOS prompt). */
  refreshPermissions: (opts?: { automation?: boolean }): Promise<PermissionsSnapshot> =>
    ipcRenderer.invoke("setup:refresh-permissions", opts),
  openSystemSettings: (pane: SettingsPane): void => ipcRenderer.send("setup:open-system-settings", pane),

  startDownload: (tierId: string): Promise<void> => ipcRenderer.invoke("setup:start-download", tierId),
  onDownloadProgress: (cb: (p: { stage: string; bytes: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { stage: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("setup:download-progress", handler);
    return () => ipcRenderer.removeListener("setup:download-progress", handler);
  },
  onDownloadDone: (cb: (result: { ok: boolean; error?: string }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { ok: boolean; error?: string }) => cb(payload);
    ipcRenderer.on("setup:download-done", handler);
    return () => ipcRenderer.removeListener("setup:download-done", handler);
  },

  finish: (): void => ipcRenderer.send("setup:finish"),
});

declare global {
  interface Window {
    openFlowSetup: {
      getInitialState: () => Promise<{
        micPermission: string;
        accessibilityPermission: string;
        automationPermission: string;
        tiers: Array<{
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
    }>;
      }>;
      requestMicPermission: () => Promise<string>;
      requestAccessibility: () => Promise<string>;
      refreshPermissions: (opts?: { automation?: boolean }) => Promise<PermissionsSnapshot>;
      openSystemSettings: (pane: SettingsPane) => void;
      startDownload: (tierId: string) => Promise<void>;
      onDownloadProgress: (cb: (p: { stage: string; bytes: number; total: number }) => void) => () => void;
      onDownloadDone: (cb: (result: { ok: boolean; error?: string }) => void) => () => void;
      finish: () => void;
    };
  }
}

export {};
