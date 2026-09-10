// `@mintplex-labs/piper-tts-web`'s `TtsSession` reuses a previously-loaded
// ONNX session internally (confirmed via a "Reusing session for TTS!" log it
// prints), even when a fresh `TtsSession` is constructed directly instead of
// via `TtsSession.create()`. So whatever caches the model lives somewhere we
// can't reach or disable purely by how we call the library's public API —
// it's a bug in the library itself, not in how it's being used here.
//
// The fix: run each call inside its own Web Worker (worker.js) and terminate
// the worker immediately afterward. A worker has a completely separate JS
// module registry from the main thread and from any other worker, so
// nothing module-scoped inside piper-tts-web can survive from one call to
// the next — regardless of what its internal caching is doing.
//
// Model files themselves are cached in OPFS, which is scoped to the origin
// rather than to a worker, so spinning up a new worker per call doesn't cost
// a re-download after the first time a given voice is used.

import type { LoadProgress, ProgressCallback } from '../progress';
import type { WorkerRequest, WorkerResponse } from './messages';

// Piper voice IDs. Full list: await (await import('@mintplex-labs/piper-tts-web')).voices()
export const VOICES = {
  en: 'en_US-hfc_female-medium',
  es: 'es_ES-davefx-medium',
};

function runInWorker(
  request: WorkerRequest,
  onProgress?: ProgressCallback,
): Promise<Extract<WorkerResponse, { type: 'done' }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === 'progress') {
        const { loaded, total } = message.progress;
        const progress: LoadProgress = {
          loaded,
          total,
          progress: total ? loaded / total : undefined,
        };
        onProgress?.(progress);
      } else if (message.type === 'done') {
        resolve(message);
        worker.terminate();
      } else if (message.type === 'error') {
        reject(new Error(message.message));
        worker.terminate();
      }
    };

    worker.onerror = (err) => {
      reject(err);
      worker.terminate();
    };

    worker.postMessage(request);
  });
}

export async function speak(
  voiceId: string,
  text: string,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const result = await runInWorker(
    { mode: 'speak', voiceId, text },
    onProgress,
  );
  if (!result.buffer || !result.mimeType) {
    throw new Error('Worker returned no audio data.');
  }
  return new Blob([result.buffer], { type: result.mimeType });
}

export async function preload(
  voiceId: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  await runInWorker({ mode: 'preload', voiceId }, onProgress);
}

/**
 * Whether the voice model is already stored in OPFS, i.e. usable without a
 * download. Only reads storage; never fetches.
 */
export async function isCached(voiceId: string): Promise<boolean> {
  const result = await runInWorker({ mode: 'check', voiceId });
  return result.stored === true;
}
