import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowPrefs", {
  load: (): Promise<unknown> => ipcRenderer.invoke("prefs:load"),
  save: (prefs: unknown): Promise<unknown> => ipcRenderer.invoke("prefs:save", prefs),
  listModels: (): Promise<{
    whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
    languages: Array<{ id: string; label: string }>;
  }> => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind: "whisper" | "llm", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:download-model", { kind, id }),
  deleteModel: (kind: "whisper" | "llm", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:delete-model", { kind, id }),
  onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, payload: { id: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("prefs:download-progress", handler);
    return () => ipcRenderer.removeListener("prefs:download-progress", handler);
  },
});

declare global {
  interface Window {
    openFlowPrefs: {
      load: () => Promise<unknown>;
      save: (prefs: unknown) => Promise<unknown>;
      listModels: () => Promise<{
        whisper: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        llm: Array<{ id: string; label: string; sizeBytes: number; installed: boolean }>;
        languages: Array<{ id: string; label: string }>;
      }>;
      downloadModel: (kind: "whisper" | "llm", id: string) => Promise<void>;
      deleteModel: (kind: "whisper" | "llm", id: string) => Promise<void>;
      onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void) => () => void;
    };
  }
}

export {};
