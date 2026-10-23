import { describe, expect, it } from "vitest";
import { recommendModels, type HardwareProfile } from "../../src/main/hardware-recommendations.js";
const mac = (gb: number, cpu = "Apple M1"): HardwareProfile => ({ totalMemoryBytes: gb * 1024 ** 3, cpu, appleSilicon: cpu.startsWith("Apple") });
describe("hardware recommendations", () => {
  it.each([[4, "fast"], [8, "balanced"], [16, "balanced"], [24, "max"], [64, "max"]] as const)("leaves headroom on a %i GB Apple Silicon Mac", (gb, tier) => {
    expect(recommendModels(mac(gb)).tierId).toBe(tier);
  });
  it("does not mistake Intel RAM capacity for Apple Silicon performance", () => {
    expect(recommendModels(mac(8, "Intel Core i5")).tierId).toBe("fast");
    expect(recommendModels(mac(32, "Intel Core i9")).tierId).toBe("balanced");
    expect(recommendModels(mac(32, "Intel Core i9")).replyModelId).toBe("gemma-3-4b");
  });
  it("does not recommend an extra resident reply server on 8 GB Macs", () => {
    expect(recommendModels(mac(8)).replyModelId).toBeNull();
    expect(recommendModels(mac(16)).replyModelId).toBe("gemma-3-4b");
    expect(recommendModels(mac(24)).replyModelId).toBe("gemma-4-e4b");
  });
  it.each([null, mac(0), mac(NaN), mac(Infinity)])("degrades safely when hardware is unavailable", (hardware) => {
    expect(recommendModels(hardware)).toMatchObject({ tierId: "fast", replyModelId: null, detected: false });
  });
});
