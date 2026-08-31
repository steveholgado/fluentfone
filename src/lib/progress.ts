export interface LoadProgress {
  loaded: number;
  total?: number;
  /** loaded / total, in [0, 1]. Undefined if total is unknown. */
  progress?: number;
}

export type ProgressCallback = (p: LoadProgress) => void;

export function formatProgress(p: LoadProgress): string {
  if (typeof p.progress === 'number') {
    return `${Math.round(p.progress * 100)}%`;
  }
  return `${(p.loaded / 1_000_000).toFixed(1)} MB`;
}
