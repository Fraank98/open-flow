export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const numSamples = samples.length;
  const byteLength = 44 + numSamples * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, byteLength - 8, true);
  writeAscii(view, 8, "WAVE");

  // fmt sub-chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);  // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono * 16-bit)
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample

  // data sub-chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, numSamples * 2, true);

  // PCM samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
