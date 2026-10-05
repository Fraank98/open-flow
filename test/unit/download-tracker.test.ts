import { describe, it, expect, vi } from "vitest";
import { DownloadTracker } from "../../src/main/utils/download-tracker.js";
import { deferred } from "../helpers/deferred.js";

describe("DownloadTracker", () => {
  it("tells progress listeners which download reported, whoever started it", async () => {
    const tracker = new DownloadTracker();
    const seen: Array<[string, { bytes: number; total: number }]> = [];
    const off = tracker.onProgress((id, p) => seen.push([id, p]));
    await tracker.start("m", async (_signal, report) => { report({ bytes: 1, total: 4 }); });
    off();
    await tracker.start("m", async (_signal, report) => { report({ bytes: 2, total: 4 }); });
    expect(seen).toEqual([["m", { bytes: 1, total: 4 }]]);
  });

  it("hands back the same promise to a second start while one is in flight", async () => {
    const tracker = new DownloadTracker();
    const d = deferred();
    const run = vi.fn(() => d.promise);
    const first = tracker.start("m", run);
    const second = tracker.start("m", run);
    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(tracker.isActive("m")).toBe(true);
    d.resolve();
    await first;
    expect(tracker.isActive("m")).toBe(false);
  });

  it("a caller that attaches late resolves only when the download really ends", async () => {
    const tracker = new DownloadTracker();
    const d = deferred();
    const first = tracker.start("m", () => d.promise);
    let lateDone = false;
    void tracker.start("m", () => Promise.resolve()).then(() => {
      lateDone = true;
    });
    await Promise.resolve();
    expect(lateDone).toBe(false);
    d.resolve();
    await first;
    expect(lateDone).toBe(true);
  });

  it("remembers the last progress while active and forgets it afterwards", async () => {
    const tracker = new DownloadTracker();
    const d = deferred();
    let report!: (p: { bytes: number; total: number }) => void;
    const p = tracker.start("m", (_signal, r) => {
      report = r;
      return d.promise;
    });
    expect(tracker.progress("m")).toBeNull();
    report({ bytes: 5, total: 10 });
    expect(tracker.progress("m")).toEqual({ bytes: 5, total: 10 });
    d.resolve();
    await p;
    expect(tracker.progress("m")).toBeNull();
  });

  it("frees the slot when the download fails, and passes the error on", async () => {
    const tracker = new DownloadTracker();
    await expect(tracker.start("m", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(tracker.isActive("m")).toBe(false);
    await expect(tracker.start("m", () => Promise.resolve())).resolves.toBeUndefined();
  });

  it("cancel aborts the signal of the running download only", async () => {
    const tracker = new DownloadTracker();
    const d = deferred();
    let signal!: AbortSignal;
    const p = tracker.start("m", (s) => {
      signal = s;
      return d.promise;
    });
    tracker.cancel("other");
    expect(signal.aborted).toBe(false);
    tracker.cancel("m");
    expect(signal.aborted).toBe(true);
    d.resolve();
    await p;
  });
});
