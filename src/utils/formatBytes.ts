/**
 * A byte count as a short label: GB to one decimal place from a gigabyte up,
 * whole MB below. Decimal units, as browsers and disks report them.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
