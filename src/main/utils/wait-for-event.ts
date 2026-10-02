/** The subset of EventEmitter we need. Declared with method syntax so both
 *  Electron's ipcMain (listener typed with IpcMainEvent) and a plain
 *  node:events EventEmitter are assignable. */
export interface EmitterLike {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/**
 * Resolve when `emitter` emits `event`, or after `timeoutMs` — whichever comes
 * first — and always clean up the loser: the listener is removed on timeout so
 * it can't be consumed by a later, unrelated emit (or pile up when the emitter
 * never fires), and the timer is cleared on the event. Resolves true if the
 * event won, false on timeout.
 */
export function waitForEventOrTimeout(emitter: EmitterLike, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onEvent = () => settle(true);
    const timer = setTimeout(() => settle(false), timeoutMs);
    const settle = (gotEvent: boolean) => {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      resolve(gotEvent);
    };
    emitter.on(event, onEvent);
  });
}
