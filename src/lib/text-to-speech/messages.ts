/** Message contracts shared between the main thread and worker.ts. */

export type TtsRequest =
  | { mode: 'speak'; voiceId: string; text: string; lengthScale?: number }
  /**
   * Creates the worker's session, downloading the voice into OPFS first if it
   * isn't there. Sent up front to warm a worker, and on its own to preload.
   */
  | { mode: 'load'; voiceId: string };

export type WorkerRequest = TtsRequest & { id: number };

// No progress message: the service worker counts the bytes as they stream
// past and broadcasts them, so they no longer have to be relayed through here.
export type WorkerResponse =
  | {
      id: number;
      type: 'done';
      buffer?: ArrayBuffer;
      mimeType?: string;
      /** Speak requests only: the `predict()` call's duration, in ms. */
      synthesisMs?: number;
    }
  | { id: number; type: 'error'; message: string };
