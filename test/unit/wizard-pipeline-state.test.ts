import { describe, it, expect } from "vitest";
import { toWizardPipelineState } from "../../src/main/utils/wizard-pipeline-state.js";

describe("toWizardPipelineState", () => {
  it("passes the live states through and renames injecting to pasting", () => {
    expect(toWizardPipelineState("recording")).toBe("recording");
    expect(toWizardPipelineState("transcribing")).toBe("transcribing");
    expect(toWizardPipelineState("cleaning")).toBe("cleaning");
    expect(toWizardPipelineState("injecting")).toBe("pasting");
  });

  it("shows idle, error and paste-failed as idle", () => {
    expect(toWizardPipelineState("idle")).toBe("idle");
    expect(toWizardPipelineState("error")).toBe("idle");
    expect(toWizardPipelineState("paste-failed")).toBe("idle");
    expect(toWizardPipelineState("copy-failed")).toBe("idle");
  });
});
