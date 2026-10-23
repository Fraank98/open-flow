import { it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.skipIf(process.platform !== "darwin")("native modifier recognition cancels chords and requires a fresh gesture", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptt-gesture-"));
  try {
    const bin = join(dir, "test");
    execFileSync("clang++", ["-std=c++17", "test/native/ptt-gesture.cpp", "-o", bin]);
    execFileSync(bin);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
