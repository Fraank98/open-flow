// Audio capture loop. Listens for IPC start/stop, streams 16 kHz mono Float32
// to main. Downsamples from the hardware rate (typically 48 kHz).
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
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    window.openFlowRecorder.reportError("mic-permission-denied:" + (err && err.message ? err.message : String(err)));
    return;
  }
  // Race-cancel: a stop/cancel fired while getUserMedia was pending. Release
  // the stream we just acquired so the mic indicator can turn off.
  if (mySession !== activeSessionId) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }

  mediaStream = stream;
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  const inputRate = audioContext.sampleRate;
  const decimation = inputRate / TARGET_SAMPLE_RATE;

  // ScriptProcessor is deprecated but the simplest API for raw PCM here.
  // AudioWorklet is the modern alternative but requires more glue. For an MVP
  // dictation app where audio chunks are processed in main, this is acceptable.
  const bufferSize = 4096;
  processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  let accumulator = 0;

  processorNode.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    // Naive linear-skip downsample. Good enough for speech recognition.
    for (let i = 0; i < inputData.length; i++) {
      accumulator++;
      if (accumulator >= decimation) {
        accumulator -= decimation;
        outBuffer.push(inputData[i]);
      }
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
  // Invalidate any in-flight startRecording() awaiting getUserMedia. When
  // that promise eventually resolves it will see the mismatched session id
  // and stop the freshly-acquired tracks itself.
  ++activeSessionId;

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  // Flush any residual samples accumulated below the 1024-sample threshold,
  // so the host gets every sample from the end of the user's utterance.
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
