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

import { hasWarmRuntime } from '../runtime-cache';
import type { LoadProgress, ProgressCallback } from '../progress';
import type { WorkerRequest, WorkerResponse } from './messages';
import { OPFS_VOICE_DIR, PIPER_RUNTIME_MARKER_KEY } from './runtime';

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

    // A voice load downloads several files (model, config, wasm) in
    // parallel, each reporting its own loaded/total. Summing across every
    // file seen so far gives one figure that only moves forward, instead
    // of the progress bar jumping between each file's individual percentage.
    const filesLoading = new Map<string, { loaded: number; total: number }>();

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === 'progress') {
        const { url, loaded, total } = message.progress;
        filesLoading.set(url, { loaded, total });

        let loadedSum = 0;
        let totalSum = 0;
        for (const file of filesLoading.values()) {
          loadedSum += file.loaded;
          totalSum += file.total;
        }

        const progress: LoadProgress = {
          loaded: loadedSum,
          total: totalSum,
          progress: totalSum ? loadedSum / totalSum : undefined,
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

/**
 * Downloads the piper/ONNX wasm the voice runs on, ahead of the voice itself
 * and reported separately. See ./runtime.ts for why it needs doing by hand.
 */
export async function preloadRuntime(
  onProgress?: ProgressCallback,
): Promise<void> {
  await runInWorker({ mode: 'runtime' }, onProgress);
}

export async function preload(
  voiceId: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  await runInWorker({ mode: 'preload', voiceId }, onProgress);
}

/** Whether the piper/ONNX wasm has already been downloaded. */
export async function isRuntimeCached(): Promise<boolean> {
  return hasWarmRuntime(PIPER_RUNTIME_MARKER_KEY);
}

/**
 * Whether the voice model is already stored in OPFS, i.e. usable without a
 * download. Only reads storage; never fetches.
 *
 * This is piper-tts-web's own `stored()` inlined — it is a plain OPFS
 * directory listing, and going through the library would mean spawning a
 * worker and loading its bundle during the check stage, before the user has
 * agreed to download anything. The tradeoff is that the layout below has to
 * track the library's; `stored()` in piper-tts-web.js is the reference.
 */
export async function isCached(voiceId: string): Promise<boolean> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_VOICE_DIR, { create: true });

  for await (const name of dir.keys()) {
    if (name.endsWith('.onnx') && name.split('.')[0] === voiceId) return true;
  }

  return false;
}
