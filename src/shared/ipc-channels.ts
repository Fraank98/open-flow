export const IpcChannels = {
  AudioChunk: "audio:chunk",
  AudioStart: "audio:start",
  AudioStop: "audio:stop",
  PipelineStateChange: "pipeline:state-change",
  PipelineCancel: "pipeline:cancel",
  PrefsGet: "prefs:get",
  PrefsSet: "prefs:set",
  ModelDownloadProgress: "model:download-progress",
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
