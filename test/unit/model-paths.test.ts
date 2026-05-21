import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getModelsDir,
  modelFilePath,
  sha256OfFile,
  fileSize,
  ModelDescriptor,
} from "../../src/main/utils/model-paths.js";

describe("getModelsDir", () => {
  it("returns a path ending in 'open-flow/models'", () => {
    const dir = getModelsDir();
    expect(dir).toMatch(/open-flow[/\\]models$/);
  });

  it("respects OPEN_FLOW_MODELS_DIR override", () => {
    const orig = process.env.OPEN_FLOW_MODELS_DIR;
    process.env.OPEN_FLOW_MODELS_DIR = "/tmp/custom";
    try {
      expect(getModelsDir()).toBe("/tmp/custom");
    } finally {
      if (orig === undefined) delete process.env.OPEN_FLOW_MODELS_DIR;
      else process.env.OPEN_FLOW_MODELS_DIR = orig;
    }
  });
});

describe("modelFilePath", () => {
  it("joins models dir with descriptor filename", () => {
    const desc: ModelDescriptor = {
      id: "whisper-base",
      filename: "ggml-base.bin",
      sizeBytes: 100,
      sha256: "abc",
      url: "https://example.com/ggml-base.bin",
    };
    const path = modelFilePath(desc);
    expect(path.endsWith("ggml-base.bin")).toBe(true);
  });
});

describe("sha256OfFile and fileSize", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "open-flow-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("computes sha256 of a small file", async () => {
    const p = join(tmp, "x.txt");
    await writeFile(p, "hello");
    // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(await sha256OfFile(p)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("reports file size", async () => {
    const p = join(tmp, "y.txt");
    await writeFile(p, "1234567890");
    expect(await fileSize(p)).toBe(10);
  });
});
