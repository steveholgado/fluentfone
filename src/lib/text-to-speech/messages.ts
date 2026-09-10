/** Message contracts shared between the main thread and worker.ts. */

export type WorkerRequest =
  | { mode: 'speak'; voiceId: string; text: string }
  | { mode: 'preload'; voiceId: string }
  | { mode: 'check'; voiceId: string };

export type WorkerResponse =
  | {
      type: 'progress';
      progress: { url: string; loaded: number; total: number };
    }
  | {
      type: 'done';
      buffer?: ArrayBuffer;
      mimeType?: string;
      /** Answer to a 'check' request: is the voice already in OPFS? */
      stored?: boolean;
    }
  | { type: 'error'; message: string };
