/** Message contracts shared between the main thread and worker.ts. */

import type { TranscribeOptions } from './types';

export type WorkerRequest =
  | ({
      id: number;
      mode: 'transcribe';
      audio: Float32Array;
    } & TranscribeOptions)
  | { id: number; mode: 'preload' };

// No progress message: the service worker counts the bytes as they stream
// past and broadcasts them, so they no longer have to be relayed through here.
export type WorkerResponse =
  | { id: number; type: 'done'; text?: string }
  | { id: number; type: 'error'; message: string };
