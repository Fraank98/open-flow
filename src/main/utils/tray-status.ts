import type { PttArmState } from "./ptt-arming.js";

export interface TrayArmerState {
  /** Text for the tray's status line. */
  status: string;
  /** Extra permission hint under the status, or null to clear it. */
  hint: string | null;
  /** Set only when the state means "ready to dictate": the status to restore after a dictation. */
  readyStatus?: string;
}

/** What the tray shows for each state of the push-to-talk armer. */
export function trayStateForArmer(state: PttArmState): TrayArmerState {
  switch (state) {
    case "armed": {
      const status = "Ready — hold ⌥ to dictate";
      return { status, hint: null, readyStatus: status };
    }
    case "waiting":
      return {
        status: "Needs Accessibility permission",
        hint: "Open System Settings › Privacy & Security › Accessibility and turn on open-flow",
      };
    case "armed-after-grant": {
      const status = "Ready — if Option doesn't respond, choose Relaunch open-flow";
      return { status, hint: null, readyStatus: status };
    }
    case "relaunch-needed":
      return { status: "Permission granted — relaunch to activate", hint: null };
  }
}
