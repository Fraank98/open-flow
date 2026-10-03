import { contextBridge, ipcRenderer } from "electron";

interface ModelInfo {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  ramBytes: number;
  installed: boolean;
  licenseNote: string | null;
}

contextBridge.exposeInMainWorld("openFlowPrefs", {
  load: (): Promise<unknown> => ipcRenderer.invoke("prefs:load"),
  save: (prefs: unknown): Promise<unknown> => ipcRenderer.invoke("prefs:save", prefs),
  restartStatus: (): Promise<{ fields: string[] }> => ipcRenderer.invoke("prefs:restart-status"),
  listModels: (): Promise<{
    whisper: ModelInfo[];
    llm: ModelInfo[];
    languages: Array<{ id: string; label: string }>;
  }> => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind: "whisper" | "llm", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:download-model", { kind, id }),
  deleteModel: (kind: "whisper" | "llm", id: string): Promise<void> =>
    ipcRenderer.invoke("prefs:delete-model", { kind, id }),
  relaunch: (): void => {
    ipcRenderer.send("prefs:relaunch");
  },
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
      restartStatus: () => Promise<{ fields: string[] }>;
      listModels: () => Promise<{
        whisper: ModelInfo[];
        llm: ModelInfo[];
        languages: Array<{ id: string; label: string }>;
      }>;
      downloadModel: (kind: "whisper" | "llm", id: string) => Promise<void>;
      deleteModel: (kind: "whisper" | "llm", id: string) => Promise<void>;
      relaunch: () => void;
      onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void) => () => void;
    };
  }
}

export {};
