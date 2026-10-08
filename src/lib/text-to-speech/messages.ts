/** Message contracts shared between the main thread and worker.ts. */

export type TtsRequest =
  | { mode: 'speak'; voiceId: string; text: string; lengthScale?: number }
  /**
   * Creates the worker's session, downloading the voice first if the service
   * worker doesn't have it. Sent up front to warm a worker.
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
    }
  | { id: number; type: 'error'; message: string };
