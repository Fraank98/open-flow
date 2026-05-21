import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowOverlay", {
  onState: (cb: (state: string) => void): (() => void) => {
    const handler = (_e: unknown, state: string) => cb(state);
    ipcRenderer.on("pipeline:state-change", handler);
    return () => ipcRenderer.removeListener("pipeline:state-change", handler);
  },
  cancel: (): void => {
    ipcRenderer.send("pipeline:cancel");
  },
});

declare global {
  interface Window {
    openFlowOverlay: {
      onState: (cb: (state: string) => void) => () => void;
      cancel: () => void;
    };
  }
}

export {};
