/** A `LoadProgress.progress` fraction as a whole-percentage label. */
export function formatProgress(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}
