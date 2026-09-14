/** Message contracts shared between the main thread and worker.ts. */

import type { LoadProgress } from '../progress';
import type { TranscribeOptions } from './index';

export type WorkerRequest =
  | ({
      id: number;
      mode: 'transcribe';
      audio: Float32Array;
    } & TranscribeOptions)
  | { id: number; mode: 'preload' };

export type WorkerResponse =
  | { id: number; type: 'progress'; progress: LoadProgress }
  | { id: number; type: 'done'; text?: string }
  | { id: number; type: 'error'; message: string };
