export const IpcChannels = {
  AudioChunk: "audio:chunk",
  AudioStart: "audio:start",
  AudioStop: "audio:stop",
  PipelineStateChange: "pipeline:state-change",
  PipelineCancel: "pipeline:cancel",
  PrefsGet: "prefs:get",
  PrefsSet: "prefs:set",
  ModelDownloadProgress: "model:download-progress",
  /** main → overlay: the payload of the suggesting state. */
  ReplySuggestions: "reply:suggestions",
  /** overlay → main: the user picked variant `id` (1, 2 or 3). */
  ReplyChoose: "reply:choose",
  /** overlay → main: the user dismissed the suggestions via the global Esc
   *  accelerator. The ✕ inside the pill is hidden while suggesting (the
   *  window never takes focus via showInactive(), so a renderer keydown for
   *  Esc would not fire reliably) — the accelerator is the primary path. */
  ReplyDismiss: "reply:dismiss",
  /** main → overlay: neutral flash text (degradation L2/L3). Never a reason
   *  that would describe what was on screen (spec §Errori). */
  ReplyFlash: "reply:flash",
  /** overlay → main: the mouse entered the pill; resets the 20 s timer. */
  ReplyHover: "reply:hover",
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
