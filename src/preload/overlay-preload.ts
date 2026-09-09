import { contextBridge, ipcRenderer } from "electron";
import { IpcChannels } from "../shared/ipc-channels.js";
import type { SuggestionPayload } from "../shared/reply-types.js";

contextBridge.exposeInMainWorld("openFlowOverlay", {
  onState: (cb: (state: string) => void): (() => void) => {
    const handler = (_e: unknown, state: string) => cb(state);
    ipcRenderer.on("pipeline:state-change", handler);
    return () => ipcRenderer.removeListener("pipeline:state-change", handler);
  },
  onPartial: (cb: (text: string) => void): (() => void) => {
    const handler = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("pipeline:partial-transcript", handler);
    return () => ipcRenderer.removeListener("pipeline:partial-transcript", handler);
  },
  cancel: (): void => {
    ipcRenderer.send("pipeline:cancel");
  },
  onSuggestions: (cb: (p: SuggestionPayload) => void): (() => void) => {
    const handler = (_e: unknown, p: SuggestionPayload) => cb(p);
    ipcRenderer.on(IpcChannels.ReplySuggestions, handler);
    return () => ipcRenderer.removeListener(IpcChannels.ReplySuggestions, handler);
  },
  onFlash: (cb: (text: string) => void): (() => void) => {
    const handler = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on(IpcChannels.ReplyFlash, handler);
    return () => ipcRenderer.removeListener(IpcChannels.ReplyFlash, handler);
  },
  choose: (id: number): void => {
    ipcRenderer.send(IpcChannels.ReplyChoose, id);
  },
  dismiss: (): void => {
    ipcRenderer.send(IpcChannels.ReplyDismiss);
  },
  hover: (): void => {
    ipcRenderer.send(IpcChannels.ReplyHover);
  },
});

declare global {
  interface Window {
    openFlowOverlay: {
      onState: (cb: (state: string) => void) => () => void;
      onPartial: (cb: (text: string) => void) => () => void;
      cancel: () => void;
      onSuggestions: (cb: (p: SuggestionPayload) => void) => () => void;
      onFlash: (cb: (text: string) => void) => () => void;
      choose: (id: number) => void;
      dismiss: () => void;
      hover: () => void;
    };
  }
}

export {};
