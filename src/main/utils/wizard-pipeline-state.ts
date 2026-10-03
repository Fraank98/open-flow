/** What the wizard's live "try it" line distinguishes; everything else reads as idle. */
export type WizardPipelineState = "idle" | "recording" | "transcribing" | "cleaning" | "pasting";

/** Maps a PipelineCoordinator state (a plain string here, to stay decoupled) to the wizard's. */
export function toWizardPipelineState(state: string): WizardPipelineState {
  switch (state) {
    case "recording":
    case "transcribing":
    case "cleaning":
      return state;
    case "injecting":
      return "pasting";
    default:
      return "idle"; // idle, error, paste-failed
  }
}
