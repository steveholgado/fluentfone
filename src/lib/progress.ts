export interface LoadProgress {
  loaded: number;
  total: number;
  /** loaded / total, in [0, 1]. */
  progress: number;
}

export type ProgressCallback = (p: LoadProgress) => void;
