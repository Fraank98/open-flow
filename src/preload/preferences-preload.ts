import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowPrefs", {
  load: (): Promise<unknown> => ipcRenderer.invoke("prefs:load"),
  save: (prefs: unknown): Promise<unknown> => ipcRenderer.invoke("prefs:save", prefs),
  listModels: (): Promise<{
    whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    replyTiers: Array<{ id: string; label: string; description: string; modelId: string; sizeBytes: number; installed: boolean }>;
    languages: Array<{ id: string; label: string }>;
  }> => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind: "whisper" | "llm" | "reply", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:download-model", { kind, id }),
  deleteModel: (kind: "whisper" | "llm" | "reply", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:delete-model", { kind, id }),
  relaunch: (): void => {
    ipcRenderer.send("prefs:relaunch");
  },
  onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("prefs:download-progress", handler);
    return () => ipcRenderer.removeListener("prefs:download-progress", handler);
  },
  replyStatus: (): Promise<{ serverState: string; serverError: string | null; hotkeyRegistered: boolean; nativeOk: boolean; lastBlockedBundleId: string | null }> =>
    ipcRenderer.invoke("prefs:reply-status"),
  validateReplyHotkey: (accelerator: string): Promise<{ ok: boolean; reason?: string; accelerator?: string }> =>
    ipcRenderer.invoke("prefs:validate-reply-hotkey", accelerator),
  replyBlockedApp: (): Promise<string | null> => ipcRenderer.invoke("prefs:reply-blocked-app"),
});

declare global {
  interface Window {
    openFlowPrefs: {
      load: () => Promise<unknown>;
      save: (prefs: unknown) => Promise<unknown>;
      listModels: () => Promise<{
        whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        replyTiers: Array<{ id: string; label: string; description: string; modelId: string; sizeBytes: number; installed: boolean }>;
        languages: Array<{ id: string; label: string }>;
      }>;
      downloadModel: (kind: "whisper" | "llm" | "reply", id: string) => Promise<void>;
      deleteModel: (kind: "whisper" | "llm" | "reply", id: string) => Promise<void>;
      relaunch: () => void;
      onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void) => () => void;
      replyStatus: () => Promise<{ serverState: string; serverError: string | null; hotkeyRegistered: boolean; nativeOk: boolean; lastBlockedBundleId: string | null }>;
      validateReplyHotkey: (accelerator: string) => Promise<{ ok: boolean; reason?: string; accelerator?: string }>;
      replyBlockedApp: () => Promise<string | null>;
    };
  }
}

export {};
