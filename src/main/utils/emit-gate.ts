/**
 * Rate gate for high-frequency events (download progress fires once per stream
 * chunk — tens of thousands of times for a multi-GB model — and every IPC send
 * costs the renderer a handler run). Returns a function to call per event: true
 * means "emit this one". The first event passes, then at most one per
 * `intervalMs`; `force` (the last event, 100%) always passes so the UI never
 * ends on a stale value. `now` is injectable for tests.
 */
export function createEmitGate(intervalMs: number, now: () => number = Date.now): (force?: boolean) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (force = false) => {
    const t = now();
    if (!force && t - last < intervalMs) return false;
    last = t;
    return true;
  };
}
