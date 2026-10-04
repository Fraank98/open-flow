import { describe, it, expect } from "vitest";
import { describeDownloadError } from "../../src/main/utils/download-errors.js";
import { formatBytes } from "../../src/main/utils/format-bytes.js";
import { InsufficientSpaceError } from "../../src/main/utils/disk-space.js";

const NET_HINT = "Check your network and try again. Downloads resume where they left off.";

describe("formatBytes", () => {
  it("uses decimal units: GB with one decimal, MB at two significant digits", () => {
    expect(formatBytes(487_601_967)).toBe("490 MB");
    expect(formatBytes(62_000_000)).toBe("62 MB");
    expect(formatBytes(1_624_555_275)).toBe("1.6 GB");
    expect(formatBytes(1_624_555_275 + 2_104_932_768)).toBe("3.7 GB");
    expect(formatBytes(900_000_000)).toBe("900 MB");
  });
  it("never prints 1000 MB, and handles small values", () => {
    expect(formatBytes(996_000_000)).toBe("1.0 GB");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(900_000)).toBe("1 MB");
  });
});

describe("describeDownloadError", () => {
  it("maps ENOSPC", () => {
    expect(describeDownloadError({ code: "ENOSPC" })).toMatchObject({
      title: "Not enough disk space",
      hint: "Free up some space on this Mac and try again.",
      retryable: true,
    });
  });

  it.each([
    new Error("fetch failed"),
    Object.assign(new Error("x"), { code: "ENOTFOUND" }),
    Object.assign(new Error("x"), { code: "ECONNRESET" }),
    Object.assign(new Error("x"), { code: "EAI_AGAIN" }),
  ])("maps network failures (%s)", (err) => {
    expect(describeDownloadError(err)).toMatchObject({
      title: "No internet connection",
      hint: NET_HINT,
      retryable: true,
    });
  });

  it("reads the code from err.cause (undici style)", () => {
    const err = new Error("fetch failed", { cause: { code: "ECONNRESET" } });
    expect(describeDownloadError(err).title).toBe("No internet connection");
  });

  it.each([503, 429])("maps busy server HTTP %i", (status) => {
    expect(describeDownloadError(new Error(`HTTP ${status} fetching https://x/y.bin`))).toMatchObject({
      title: `The model server is busy (HTTP ${status})`,
      hint: "Try again in a few minutes.",
      retryable: true,
    });
  });

  it.each([404, 403])("maps missing model HTTP %i as not retryable", (status) => {
    expect(describeDownloadError(new Error(`HTTP ${status} fetching https://x/y.bin`))).toMatchObject({
      title: `Model not found at its download address (HTTP ${status})`,
      hint: "This is an open-flow bug — please report it on GitHub.",
      retryable: false,
    });
  });

  it("maps sha256 and size mismatches without leaking hashes", () => {
    const sha = "a".repeat(64);
    const r = describeDownloadError(new Error(`sha256 mismatch for m.bin: expected ${sha}, got ${"b".repeat(64)}`));
    expect(r).toMatchObject({ title: "The download was corrupted", hint: "Trying again usually fixes it.", retryable: true });
    expect(JSON.stringify(r)).not.toMatch(/[0-9a-f]{64}/);
    expect(describeDownloadError(new Error("size mismatch: expected 5, got 3")).title).toBe("The download was corrupted");
  });

  it("maps AbortError to a paused state", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(describeDownloadError(err)).toMatchObject({ title: "Download paused", hint: "", code: "aborted" });
  });

  it("explains InsufficientSpaceError with formatted sizes", () => {
    const r = describeDownloadError(new InsufficientSpaceError(1_624_555_275, 900_000_000));
    expect(r.title).toBe("Not enough disk space");
    expect(r.hint).toBe("You need 1.6 GB free but only 0.9 GB is available. Free up space and try again.");
  });

  it("falls back to a generic title with the message as hint", () => {
    expect(describeDownloadError(new Error("weird"))).toMatchObject({ title: "Download failed", hint: "weird" });
    expect(describeDownloadError("str").hint).toBe("str");
  });
});
