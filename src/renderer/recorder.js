// Audio capture loop. Listens for IPC start/stop, streams 16 kHz mono Float32
// to main. Downsamples from the hardware rate (typically 48 kHz).
"use strict";

const TARGET_SAMPLE_RATE = 16000;

let audioContext = null;
let mediaStream = null;
let processorNode = null;

async function startRecording() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
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
  let outBuffer = [];

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
  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
    processorNode = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
}

window.openFlowRecorder.onStart(() => { startRecording(); });
window.openFlowRecorder.onStop(() => { stopRecording(); });
window.openFlowRecorder.reportReady();
