import { describe, it, expect } from "vitest";
import { encodeWav } from "../../src/main/utils/wav-encoder.js";

describe("encodeWav", () => {
  it("produces a valid WAV header for 16 kHz mono PCM 16-bit", () => {
    const samples = new Float32Array(16000); // 1 second silence
    const wav = encodeWav(samples, 16000);
    // RIFF header
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    // fmt chunk
    expect(new TextDecoder().decode(wav.slice(12, 16))).toBe("fmt ");
    // data chunk identifier at offset 36
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
  });

  it("encodes total byte length as 44 + 2 * numSamples", () => {
    const samples = new Float32Array(16000);
    const wav = encodeWav(samples, 16000);
    expect(wav.byteLength).toBe(44 + samples.length * 2);
  });

  it("clips samples outside [-1, 1] to int16 range", () => {
    const samples = new Float32Array([2.0, -2.0, 0]);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset + 44);
    expect(view.getInt16(0, true)).toBe(32767);
    expect(view.getInt16(2, true)).toBe(-32768);
    expect(view.getInt16(4, true)).toBe(0);
  });

  it("encodes sample rate and byte rate correctly", () => {
    const samples = new Float32Array(100);
    const wav = encodeWav(samples, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset);
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
  });
});
