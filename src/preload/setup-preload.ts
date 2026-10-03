import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowSetup", {
  getInitialState: (): Promise<{
    micPermission: string;
    accessibilityPermission: string;
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
  refreshAccessibilityStatus: (): Promise<string> => ipcRenderer.invoke("setup:refresh-accessibility"),
  openAccessibilitySettings: (): void => ipcRenderer.send("setup:open-accessibility-settings"),
  openMicSettings: (): void => ipcRenderer.send("setup:open-mic-settings"),

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
      refreshAccessibilityStatus: () => Promise<string>;
      openAccessibilitySettings: () => void;
      openMicSettings: () => void;
      startDownload: (tierId: string) => Promise<void>;
      onDownloadProgress: (cb: (p: { stage: string; bytes: number; total: number }) => void) => () => void;
      onDownloadDone: (cb: (result: { ok: boolean; error?: string }) => void) => () => void;
      finish: () => void;
    };
  }
}

export {};
