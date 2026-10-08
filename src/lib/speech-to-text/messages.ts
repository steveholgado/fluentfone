/** Message contracts shared between the main thread and worker.ts. */

import type { TranscribeOptions } from './types';

export type SttRequest =
  | ({ mode: 'transcribe'; audio: Float32Array } & TranscribeOptions)
  /** Downloads the runtime and weights, without building the pipeline. */
  | { mode: 'preload' }
  /** Builds the pipeline, so the first transcription doesn't wait for it. */
  | { mode: 'load' };

export type WorkerRequest = SttRequest & { id: number };

// No progress message: the service worker counts the bytes as they stream
// past and broadcasts them, so they no longer have to be relayed through here.
export type WorkerResponse =
  | { id: number; type: 'done'; text?: string }
  | { id: number; type: 'error'; message: string };
