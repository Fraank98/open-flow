import { contextBridge, ipcRenderer } from "electron";
import type { SuggestionPayload } from "../shared/reply-types.js";

// Preload scripts compile to CommonJS (tsconfig.preload.json) while the rest
// of the packaged app is ESM ("type": "module" in package.json + main built
// as ESM). src/shared/**/*.ts is compiled twice, once per format, into the
// SAME dist/shared/*.js path — whichever build step runs last wins on disk.
// A runtime `import`/`require` of ../shared from a preload file therefore
// either breaks the CJS preload (if shared ends up ESM) or breaks every ESM
// consumer of that shared module, such as dist/main/overlay-window.js, with
// "SyntaxError: does not provide an export named ..." at app startup (see
// build-fix-report.md in this branch's sdd folder). Use string literals for
// IPC channel names here instead — the three preexisting channels below
// already followed this convention.

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
    ipcRenderer.on("reply:suggestions", handler);
    return () => ipcRenderer.removeListener("reply:suggestions", handler);
  },
  onFlash: (cb: (text: string) => void): (() => void) => {
    const handler = (_e: unknown, text: string) => cb(text);
    ipcRenderer.on("reply:flash", handler);
    return () => ipcRenderer.removeListener("reply:flash", handler);
  },
  choose: (id: number): void => {
    ipcRenderer.send("reply:choose", id);
  },
  dismiss: (): void => {
    ipcRenderer.send("reply:dismiss");
  },
  hover: (): void => {
    ipcRenderer.send("reply:hover");
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
