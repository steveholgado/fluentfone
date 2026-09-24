/** Message contracts shared between the main thread and worker.ts. */

import type { TranscribeDevice, TranscribeOptions } from './types';

export type WorkerRequest =
  | ({
      id: number;
      mode: 'transcribe';
      audio: Float32Array;
      // `onTimings` stays behind: a function can't be structured-cloned.
    } & Pick<TranscribeOptions, 'language' | 'task'>)
  | { id: number; mode: 'preload' };

// No progress message: the service worker counts the bytes as they stream
// past and broadcasts them, so they no longer have to be relayed through here.
export type WorkerResponse =
  | {
      id: number;
      type: 'done';
      text?: string;
      /** Transcriptions only: the pipeline call's duration, in ms. */
      inferenceMs?: number;
      /** Transcriptions only. */
      device?: TranscribeDevice;
    }
  | { id: number; type: 'error'; message: string };
