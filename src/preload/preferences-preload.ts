import { contextBridge, ipcRenderer } from "electron";

type ModelKind = "whisper" | "llm" | "reply";
type Permission = "granted" | "denied" | "unknown";
type Pane = "accessibility" | "microphone" | "automation";

interface ModelInfo {
  id: string;
  label: string;
  description: string;
  sizeBytes: number;
  ramBytes: number;
  installed: boolean;
  licenseNote: string | null;
  /** A download is in flight (possibly started before this window opened). */
  downloading: boolean;
  /** Last progress of that download, when known. */
  progress: { bytes: number; total: number } | null;
}

interface ReplyTierInfo {
  id: string;
  label: string;
  description: string;
  modelId: string;
  sizeBytes: number;
  installed: boolean;
}

interface ReplyStatusInfo {
  serverState: string;
  serverError: string | null;
  hotkeyRegistered: boolean;
  nativeOk: boolean;
  lastBlockedBundleId: string | null;
}

interface PrefsApi {
  load: () => Promise<unknown>;
  /** Autosave: send only the fields that changed. Resolves with the saved prefs. */
  update: (patch: Record<string, unknown>) => Promise<unknown>;
  restartStatus: () => Promise<{ fields: string[] }>;
  listModels: () => Promise<{
    whisper: ModelInfo[];
    llm: ModelInfo[];
    replyTiers: ReplyTierInfo[];
    languages: Array<{ id: string; label: string }>;
  }>;
  downloadModel: (kind: ModelKind, id: string) => Promise<void>;
  cancelDownload: (id: string) => void;
  deleteModel: (kind: ModelKind, id: string) => Promise<void>;
  relaunch: () => void;
  onDownloadProgress: (cb: (p: { id: string; bytes: number; total: number }) => void) => () => void;
  permissionsStatus: (opts?: { automation?: boolean }) => Promise<{ mic: Permission; accessibility: Permission; automation: Permission }>;
  openSystemSettings: (pane: Pane) => void;
  openLogs: () => void;
  revealModels: () => void;
  openProjectPage: () => void;
  resetSetup: () => Promise<boolean>;
  appInfo: () => Promise<{ version: string }>;
  onShowTab: (cb: (tab: string) => void) => () => void;
  replyStatus: () => Promise<ReplyStatusInfo>;
  validateReplyHotkey: (accelerator: string) => Promise<{ ok: boolean; reason?: string; accelerator?: string }>;
}

const api: PrefsApi = {
  load: () => ipcRenderer.invoke("prefs:load"),
  update: (patch) => ipcRenderer.invoke("prefs:update", patch),
  restartStatus: () => ipcRenderer.invoke("prefs:restart-status"),
  listModels: () => ipcRenderer.invoke("prefs:list-models"),
  downloadModel: (kind, id) => ipcRenderer.invoke("prefs:download-model", { kind, id }),
  cancelDownload: (id) => {
    ipcRenderer.send("prefs:cancel-download", id);
  },
  deleteModel: (kind, id) => ipcRenderer.invoke("prefs:delete-model", { kind, id }),
  relaunch: () => {
    ipcRenderer.send("prefs:relaunch");
  },
  onDownloadProgress: (cb) => {
    const handler = (_e: unknown, payload: { id: string; bytes: number; total: number }) => cb(payload);
    ipcRenderer.on("prefs:download-progress", handler);
    return () => ipcRenderer.removeListener("prefs:download-progress", handler);
  },
  permissionsStatus: (opts) => ipcRenderer.invoke("prefs:permissions-status", opts),
  openSystemSettings: (pane) => {
    ipcRenderer.send("prefs:open-system-settings", pane);
  },
  openLogs: () => {
    ipcRenderer.send("prefs:open-logs");
  },
  revealModels: () => {
    ipcRenderer.send("prefs:reveal-models");
  },
  openProjectPage: () => {
    ipcRenderer.send("prefs:open-external", "https://github.com/Fraank98/open-flow");
  },
  resetSetup: () => ipcRenderer.invoke("prefs:reset-setup"),
  appInfo: () => ipcRenderer.invoke("prefs:app-info"),
  replyStatus: () => ipcRenderer.invoke("prefs:reply-status"),
  validateReplyHotkey: (accelerator) => ipcRenderer.invoke("prefs:validate-reply-hotkey", accelerator),
  onShowTab: (cb) => {
    const handler = (_e: unknown, tab: string) => cb(tab);
    ipcRenderer.on("prefs:show-tab", handler);
    return () => ipcRenderer.removeListener("prefs:show-tab", handler);
  },
};

contextBridge.exposeInMainWorld("openFlowPrefs", api);

declare global {
  interface Window {
    openFlowPrefs: PrefsApi;
  }
}

export {};
