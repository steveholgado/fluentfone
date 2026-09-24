/** Message contracts shared between the main thread and worker.ts. */

export type WorkerRequest =
  | { mode: 'speak'; voiceId: string; text: string; lengthScale?: number }
  | { mode: 'preload'; voiceId: string };

// No progress message: the service worker counts the bytes as they stream
// past and broadcasts them, so they no longer have to be relayed through here.
export type WorkerResponse =
  | {
      type: 'done';
      buffer?: ArrayBuffer;
      mimeType?: string;
    }
  | { type: 'error'; message: string };
