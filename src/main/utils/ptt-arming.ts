export type PttArmState = "armed" | "waiting" | "armed-after-grant" | "relaunch-needed";

export interface PttArmerOptions {
  /** Live Accessibility trust (AXIsProcessTrusted). */
  isTrusted: () => boolean;
  /** Installs the monitor; returns false if macOS still refuses (trustRequired). */
  start: () => boolean;
  intervalMs: number;
  onState: (state: PttArmState) => void;
}

export interface PttArmer {
  /** Arms now if trusted, otherwise polls until Accessibility is granted. Safe to call again. */
  arm(): void;
  /** Stops polling. Does not stop the monitor itself. */
  stop(): void;
}

/**
 * Arms push-to-talk as soon as Accessibility is granted, replacing the old
 * blocking "quit and relaunch" dialog. If the grant arrives but the monitor
 * still can't install, reports "relaunch-needed" as the safety net.
 */
export function createPttArmer(opts: PttArmerOptions): PttArmer {
  let timer: ReturnType<typeof setInterval> | null = null;

  const clear = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tryStart = (afterWait: boolean): void => {
    if (opts.start()) opts.onState(afterWait ? "armed-after-grant" : "armed");
    else opts.onState("relaunch-needed");
  };

  return {
    arm(): void {
      clear();
      if (opts.isTrusted()) {
        tryStart(false);
        return;
      }
      opts.onState("waiting");
      timer = setInterval(() => {
        if (!opts.isTrusted()) return;
        clear();
        tryStart(true);
      }, opts.intervalMs);
    },
    stop: clear,
  };
}
