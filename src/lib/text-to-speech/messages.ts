/** Message contracts shared between the main thread and worker.ts. */

export type WorkerRequest =
  | { mode: 'speak'; voiceId: string; text: string }
  /** Download the piper/ONNX wasm, without touching the voice model. */
  | { mode: 'runtime' }
  | { mode: 'preload'; voiceId: string };

export type WorkerResponse =
  | {
      type: 'progress';
      progress: { url: string; loaded: number; total: number };
    }
  | {
      type: 'done';
      buffer?: ArrayBuffer;
      mimeType?: string;
    }
  | { type: 'error'; message: string };
