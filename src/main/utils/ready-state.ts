import type { PttArmState } from "./ptt-arming.js";

/**
 * What the wizard's final step shows about the app. "starting" is the initial
 * state, "paused" comes from the tray's Pause; the rest follow the PTT armer.
 */
export type WizardReadyState = "starting" | "ready" | "accessibility-off" | "relaunch-needed" | "paused";

/** Maps the armer's state to the wizard's, so the step never sits on "Starting up…" while blocked. */
export function readyStateForArmer(state: PttArmState): WizardReadyState {
  switch (state) {
    case "armed":
    case "armed-after-grant":
      return "ready";
    case "waiting":
      return "accessibility-off";
    case "relaunch-needed":
      return "relaunch-needed";
  }
}
