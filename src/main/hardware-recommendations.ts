import { arch, cpus, platform, totalmem } from "node:os";
import { getTier, type TierDescriptor } from "./model-catalog.js";

export interface HardwareProfile {
  totalMemoryBytes: number;
  cpu: string;
  appleSilicon: boolean;
}

/** Local only. CPU model also recognises Apple Silicon under Rosetta. */
export function readHardware(): HardwareProfile | null {
  try {
    const cpu = cpus()[0]?.model?.trim() || "Unknown processor";
    return {
      totalMemoryBytes: totalmem(), cpu,
      appleSilicon: platform() === "darwin" && (arch() === "arm64" || /^Apple\b/i.test(cpu)),
    };
  } catch {
    return null;
  }
}

/** Conservative capacity heuristics, not speed benchmarks. Total memory is
 * stable across launches; free memory would change the suggestion with every
 * background app. Reply thresholds allow even the largest dictation pair to
 * remain resident alongside macOS and other apps. Choices are never enforced. */
export function recommendModels(hardware: HardwareProfile | null) {
  const detected = !!hardware && Number.isFinite(hardware.totalMemoryBytes) && hardware.totalMemoryBytes > 0;
  const gb = detected ? hardware.totalMemoryBytes / 1024 ** 3 : 0;
  const apple = detected && hardware.appleSilicon;
  const tierId: TierDescriptor["id"] = !detected || gb < 8 || (!apple && gb < 16)
    ? "fast" : apple && gb >= 24 ? "max" : "balanced";
  const tier = getTier(tierId)!;
  const replyModelId = gb < 16 ? null : apple && gb >= 24 ? "gemma-4-e4b" : "gemma-3-4b";
  const machine = detected ? `${hardware.cpu} · ${Math.round(gb)} GB RAM.` : "Hardware could not be detected.";
  const reason = tierId === "fast" ? "Lighter models leave more room for macOS and your apps."
    : tierId === "max" ? "This Apple Silicon Mac has room for the larger dictation models."
    : "Balanced keeps memory use and processing time modest.";
  return {
    detected, tierId, whisperModelId: tier.whisperId, llmModelId: tier.llmId, replyModelId,
    summary: `${machine} ${reason} This is an estimate, not a speed measurement; you can choose any model.`,
    replySummary: `${machine} ${replyModelId === null
      ? "No reply model is recommended: leave room for dictation, macOS and other apps. You can still choose one."
      : replyModelId === "gemma-4-e4b"
        ? "The larger reply model fits alongside dictation, but responses may take longer."
        : "The smaller reply model leaves room for dictation and other apps."} Memory needs are estimates.`,
  };
}
