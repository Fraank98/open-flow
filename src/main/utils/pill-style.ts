import { PILL_WINDOW_SIZE, SUGGEST_WINDOW_SIZE, type Size } from "./overlay-bounds.js";
export type PillStyle = "compact" | "preview" | "minimal";
export function isPillStyle(value: unknown): value is PillStyle {
  return value === "compact" || value === "preview" || value === "minimal";
}
export function normalizePillStyle(value: unknown): PillStyle {
  return isPillStyle(value) ? value : "compact";
}
export function pillWindowSize(style: PillStyle, state: string): Size {
  if (state === "suggesting") return { ...SUGGEST_WINDOW_SIZE };
  // Wider status messages and reply flows keep their readable geometry.
  if (!["idle", "recording", "transcribing", "cleaning", "injecting"].includes(state)) return { ...PILL_WINDOW_SIZE };
  return style === "preview" ? { width: 420, height: 188 }
    : { width: style === "minimal" ? 286 : 370, height: 116 };
}
/** RMS of the existing PCM stream; no additional microphone capture. */
export function audioLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += Number.isFinite(sample) ? sample * sample : 0;
  return Math.min(1, Math.sqrt(sum / samples.length) * 8);
}
