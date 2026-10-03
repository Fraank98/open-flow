/**
 * Human-readable size, decimal units (1 MB = 1_000_000 B, 1 GB = 1_000_000_000 B),
 * matching how the model hosts and macOS Finder report sizes.
 *
 * Rule: >= 1 GB -> one decimal ("1.6 GB"); below that, megabytes rounded to two
 * significant digits ("490 MB" for 487_601_967, "62 MB"), because the catalog
 * sizes are approximate anyway. A value that would round up to "1000 MB" is
 * shown as GB instead. Keep in sync with `formatBytes` in
 * src/renderer/lib/setup-logic.js (T10).
 */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes);
  let mb = n / 1_000_000;
  if (mb >= 100) mb = Math.round(mb / 10) * 10;
  else mb = Math.round(mb);
  if (n >= 1_000_000_000 || mb >= 1000) return `${(n / 1_000_000_000).toFixed(1)} GB`;
  if (n > 0 && mb === 0) mb = 1;
  return `${mb} MB`;
}

/** Always gigabytes with one decimal ("0.9 GB"); used where two sizes are compared side by side. */
export function formatGigabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000_000).toFixed(1)} GB`;
}
