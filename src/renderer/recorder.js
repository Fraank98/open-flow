// Audio capture loop. Listens for IPC start/stop, streams 16 kHz mono Float32
// PCM to main. AudioContext is created at the target sample rate so the
// browser's high-quality resampler handles the 48 kHz → 16 kHz conversion
// (a naive linear-skip downsample aliased high-frequency content into the
// speech band and visibly degraded transcription quality).
"use strict";

const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let processorNode = null;
let outBuffer = [];
// Session id is bumped on every stopRecording() and on every startRecording()
// entry. If an in-flight getUserMedia() promise resolves and discovers its
// session was superseded, it must release the freshly-created MediaStream
// immediately — otherwise the macOS mic indicator stays on indefinitely.
let activeSessionId = 0;

async function startRecording() {
  const mySession = ++activeSessionId;
  outBuffer = [];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Light preprocessing on — Whisper handles raw audio fine, but on
        // built-in MacBook mics noise suppression actually helps the model
        // by removing fan / keyboard noise that otherwise gets transcribed
        // as filler words.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    window.openFlowRecorder.reportError("mic-permission-denied:" + (err && err.message ? err.message : String(err)));
    return;
  }
  if (mySession !== activeSessionId) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }

  mediaStream = stream;
  // Force the context to 16 kHz so the browser's resampler does the
  // anti-aliased downsample for us. ScriptProcessor then delivers
  // already-resampled mono Float32 buffers — no manual decimation needed.
  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);

  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Copy the samples — the underlying buffer is reused by Web Audio.
    for (let i = 0; i < inputData.length; i++) {
      outBuffer.push(inputData[i]);
    }
    if (outBuffer.length >= 1024) {
      const chunk = new Float32Array(outBuffer);
      outBuffer = [];
      window.openFlowRecorder.sendChunk(chunk);
    }
  };

  source.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

async function stopRecording() {
  ++activeSessionId;
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (outBuffer.length > 0) {
    const chunk = new Float32Array(outBuffer);
    outBuffer = [];
    window.openFlowRecorder.sendChunk(chunk);
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  window.openFlowRecorder.sendEndOfStream();
}

window.openFlowRecorder.onStart(() => { startRecording(); });
window.openFlowRecorder.onStop(() => { stopRecording(); });
window.openFlowRecorder.reportReady();
