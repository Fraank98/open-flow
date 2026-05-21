import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("openFlowRecorder", {
  onStart: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("audio:start", handler);
    return () => ipcRenderer.removeListener("audio:start", handler);
  },
  onStop: (cb: () => void): (() => void) => {
    const handler = () => cb();
    ipcRenderer.on("audio:stop", handler);
    return () => ipcRenderer.removeListener("audio:stop", handler);
  },
  sendChunk: (samples: Float32Array): void => {
    // Transfer the underlying buffer for zero-copy
    ipcRenderer.send("audio:chunk", samples.buffer, samples.byteOffset, samples.length);
  },
  reportError: (message: string): void => {
    ipcRenderer.send("audio:error", message);
  },
  reportReady: (): void => {
    ipcRenderer.send("audio:ready");
  },
});

declare global {
  interface Window {
    openFlowRecorder: {
      onStart: (cb: () => void) => () => void;
      onStop: (cb: () => void) => () => void;
      sendChunk: (samples: Float32Array) => void;
      reportError: (message: string) => void;
      reportReady: () => void;
    };
  }
}

export {};
