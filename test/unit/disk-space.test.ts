import { describe, it, expect } from "vitest";
import { ensureFreeSpace, InsufficientSpaceError } from "../../src/main/utils/disk-space.js";

const statfsOf = (bavail: number, bsize = 4096) => async () => ({ bavail, bsize });

describe("ensureFreeSpace", () => {
  it("returns the free bytes when there is enough room (with a 5% margin)", async () => {
    const free = await ensureFreeSpace("/x", 1000, statfsOf(1000, 4096));
    expect(free).toBe(4_096_000);
  });

  it("throws InsufficientSpaceError when free < needed * 1.05", async () => {
    // free = 1050 bytes exactly is ok-ish boundary: needed 1000 -> 1050 required
    await expect(ensureFreeSpace("/x", 1000, statfsOf(1049, 1))).rejects.toBeInstanceOf(InsufficientSpaceError);
    await expect(ensureFreeSpace("/x", 1000, statfsOf(1050, 1))).resolves.toBe(1050);
  });

  it("carries need and have on the error", async () => {
    const err = await ensureFreeSpace("/x", 1000, statfsOf(10, 1)).catch((e) => e);
    expect(err).toMatchObject({ needBytes: 1000, haveBytes: 10 });
  });

  it("does nothing when nothing is needed", async () => {
    await expect(ensureFreeSpace("/x", 0, statfsOf(0, 1))).resolves.toBe(0);
  });
});
