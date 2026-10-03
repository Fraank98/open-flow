import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelManager } from "../../src/main/model-manager.js";
import type { ModelDescriptor } from "../../src/main/utils/model-paths.js";

const desc = (id: string): ModelDescriptor => ({ id, filename: `${id}.bin`, sizeBytes: 3, sha256: "x", url: "https://x" });
const A = desc("a");
const B = desc("b");
const C = desc("c");

describe("ModelManager file cleanup", () => {
  let dir: string;
  beforeEach(async () => {
    process.env.OPEN_FLOW_MODELS_DIR = dir = await mkdtemp(join(tmpdir(), "of-models-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env.OPEN_FLOW_MODELS_DIR;
  });
  const exists = (name: string) =>
    access(join(dir, name)).then(
      () => true,
      () => false,
    );

  it("deleteModel removes the file and its .partial", async () => {
    await writeFile(join(dir, "a.bin"), "abc");
    await writeFile(join(dir, "a.bin.partial"), "ab");
    await new ModelManager().deleteModel(A);
    expect(await exists("a.bin")).toBe(false);
    expect(await exists("a.bin.partial")).toBe(false);
  });

  it("deleteModel removes a lone .partial, and is fine when nothing exists", async () => {
    await writeFile(join(dir, "a.bin.partial"), "ab");
    const mgr = new ModelManager();
    await mgr.deleteModel(A);
    expect(await exists("a.bin.partial")).toBe(false);
    await expect(mgr.deleteModel(B)).resolves.toBeUndefined();
  });

  it("deleteModel surfaces an error other than 'not found'", async () => {
    // A directory where the file should be: unlink fails with EISDIR/EPERM, not ENOENT.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "a.bin"));
    await expect(new ModelManager().deleteModel(A)).rejects.toThrow();
  });

  it("removeOrphanPartials deletes the .partial of models outside the kept set only", async () => {
    await writeFile(join(dir, "a.bin.partial"), "x");
    await writeFile(join(dir, "b.bin.partial"), "x");
    await writeFile(join(dir, "c.bin"), "abc");
    await new ModelManager().removeOrphanPartials([A], [A, B, C]);
    expect(await exists("a.bin.partial")).toBe(true); // belongs to the chosen tier
    expect(await exists("b.bin.partial")).toBe(false);
    expect(await exists("c.bin")).toBe(true); // finished files are never touched
  });
});
