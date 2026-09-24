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

import { hasStep, markStep } from '#/lib/cache/markers';
import { trackStep } from '#/lib/preload/track';
import type { ProgressCallback } from '#/lib/progress';
import {
  OPFS_VOICE_DIR,
  RUNTIME_KEY,
  SLOW_LENGTH_SCALE,
  WASM_FILES,
} from './constants';
import type { WorkerRequest, WorkerResponse } from './messages';
import type { SpeakOptions } from './types';

export { VOICES } from './constants';

function runInWorker(
  request: WorkerRequest,
): Promise<Extract<WorkerResponse, { type: 'done' }>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      if (message.type === 'done') {
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
  { slow = false }: SpeakOptions = {},
): Promise<Blob> {
  // Normally silent: after preload the voice is in OPFS and nothing is
  // fetched. It only reports where the conversation was reached without a
  // preload, or the voice has been evicted since.
  const stop = trackStep('text-to-speech', onProgress);

  let result;
  try {
    result = await runInWorker({
      mode: 'speak',
      voiceId,
      text,
      ...(slow && { lengthScale: SLOW_LENGTH_SCALE }),
    });
  } finally {
    stop();
  }

  if (!result.buffer || !result.mimeType) {
    throw new Error('Worker returned no audio data.');
  }
  return new Blob([result.buffer], { type: result.mimeType });
}

/**
 * Pulls the piper/ONNX wasm through so the service worker stores it, ahead of
 * the voice itself and reported as its own step. Nothing is kept here — the
 * bytes are wanted on disk, not in memory. See ./runtime.ts for why this is
 * fetched by hand rather than left to the library.
 */
export async function preloadRuntime(): Promise<void> {
  await Promise.all(
    WASM_FILES.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to download tts runtime (${response.status}): ${url}`,
        );
      }
      await response.arrayBuffer();
    }),
  );

  await markStep('text-to-speech-runtime', RUNTIME_KEY);
}

export async function preload(voiceId: string): Promise<void> {
  await runInWorker({ mode: 'preload', voiceId });
}

/** Whether the piper/ONNX wasm has already been downloaded. */
export async function isRuntimeCached(): Promise<boolean> {
  return hasStep('text-to-speech-runtime', RUNTIME_KEY);
}

/**
 * Whether the voice model is already stored in OPFS, i.e. usable without a
 * download. Only reads storage; never fetches.
 *
 * This is the one asset the service worker does not own — piper-tts-web writes
 * voices to OPFS and offers no way to point it elsewhere, so caching them a
 * second time would just pay for the voice twice. Reading OPFS directly is a
 * better answer than a marker would be anyway, since it measures the bytes
 * rather than vouching for them.
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
