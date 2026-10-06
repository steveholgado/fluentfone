/**
 * Browser-based text-to-speech using Piper voices, each run in a Web Worker.
 *
 * Every voice gets a worker of its own, kept for as long as the voice is open
 * — a whole conversation, normally. That ties a voice's session, and the
 * memory behind it, to one thing that can be terminated: closing the voice
 * frees all of it, and a worker that fails is thrown away and replaced rather
 * than repaired. One worker can serve a whole conversation because a
 * conversation never changes voice, and speed is a per-line option rather
 * than something baked into the session.
 *
 * Voice files are stored by the service worker, which is scoped to the origin
 * rather than to a worker, so a fresh worker doesn't re-download a voice used
 * before.
 */

import { hasAsset, hasStep, markStep } from '#/lib/cache/markers';
import { pullThrough } from '#/lib/cache/pull-through';
import { trackStep } from '#/lib/preload/track';
import type { ProgressCallback } from '#/lib/progress';
import { RUNTIME_KEY, WASM_FILES, voiceUrls } from './constants';
import type { TtsRequest, WorkerRequest, WorkerResponse } from './messages';
import type { SpeakOptions } from './types';

export { VOICES } from './constants';
export type { SpeakOptions, SpeakTimings } from './types';

type DoneResponse = Extract<WorkerResponse, { type: 'done' }>;

/** One voice, loaded in a worker of its own and kept until closed. */
export interface Voice {
  /**
   * Settles when the current worker's session has loaded, or failed to. Needn't
   * be awaited before `speak()`, which waits for the session itself.
   */
  readonly ready: Promise<void>;
  speak(text: string, options?: SpeakOptions): Promise<Blob>;
  /** Terminates the worker. Anything still in flight rejects. */
  close(): void;
}

/**
 * Starts loading `voiceId` straight away, so the session is warm by the time
 * the first line needs speaking.
 *
 * `onProgress` hears about the voice's download while a worker is loading. It
 * is normally silent: after preload the voice is in the service worker's cache
 * and nothing is fetched from the network. It only reports where the conversation was reached without a
 * preload, or the voice has been evicted since.
 *
 * A worker that fails — its session couldn't load, or the worker itself
 * crashed — is thrown away, and the next `speak()` starts a new one.
 */
export function openVoice(
  voiceId: string,
  onProgress?: ProgressCallback,
): Voice {
  let worker: Worker | null = null;
  let ready: Promise<void> = Promise.resolve();
  let closed = false;
  let nextRequestId = 0;
  const pending = new Map<
    number,
    { resolve: (response: DoneResponse) => void; reject: (err: Error) => void }
  >();

  function discard(target: Worker, err: Error) {
    if (worker !== target) return;
    target.terminate();
    worker = null;
    for (const request of pending.values()) request.reject(err);
    pending.clear();
  }

  function send(target: Worker, request: TtsRequest): Promise<DoneResponse> {
    return new Promise((resolve, reject) => {
      const id = nextRequestId++;
      pending.set(id, { resolve, reject });
      target.postMessage({ ...request, id } satisfies WorkerRequest);
    });
  }

  function spawn(): Worker {
    const spawned = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: `text-to-speech: ${voiceId}`,
    });
    worker = spawned;

    spawned.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);

      if (message.type === 'done') request.resolve(message);
      else request.reject(new Error(message.message));
    };

    spawned.onerror = (event) => {
      discard(
        spawned,
        new Error(event.message || 'Text-to-speech worker failed.'),
      );
    };

    const stop = trackStep('text-to-speech', onProgress);
    ready = send(spawned, { mode: 'load', voiceId }).then(
      () => stop(),
      (err: Error) => {
        stop();
        // Replaced rather than asked again: the next speak() starts a fresh
        // worker, which loads the voice from scratch.
        discard(spawned, err);
        throw err;
      },
    );
    // Marked as handled: nothing is obliged to await `ready`, and a failure
    // reaches `speak()` through its own request anyway.
    ready.catch(() => {});

    return spawned;
  }

  spawn();

  return {
    get ready() {
      return ready;
    },

    async speak(text, { speed = 1, onTimings } = {}) {
      if (closed) throw new Error('This voice has been closed.');

      const start = performance.now();
      const result = await send(worker ?? spawn(), {
        mode: 'speak',
        voiceId,
        text,
        ...(speed !== 1 && { lengthScale: 1 / speed }),
      });

      if (!result.buffer || !result.mimeType) {
        throw new Error('Worker returned no audio data.');
      }

      // Startup is what's left of the round trip once synthesis is taken out:
      // waiting on a session still loading, and the messaging either side.
      // Near zero once the voice is warm.
      const synthesis = result.synthesisMs ?? 0;
      onTimings?.({
        startup: performance.now() - start - synthesis,
        synthesis,
      });

      return new Blob([result.buffer], { type: result.mimeType });
    },

    close() {
      closed = true;
      if (worker) discard(worker, new Error('This voice has been closed.'));
    },
  };
}

/**
 * Pulls the piper/ONNX wasm through so the service worker stores it, ahead of
 * the voice itself and reported as its own step. See ./constants.ts for why
 * it is fetched up front rather than left to the first session.
 */
export async function preloadRuntime(): Promise<void> {
  await pullThrough(WASM_FILES, 'text-to-speech runtime');
  await markStep('text-to-speech-runtime', RUNTIME_KEY);
}

/**
 * Pulls a voice's model and config through so the service worker stores
 * them. Only downloads: the session is built when the conversation opens the
 * voice, so there is no worker to start or model to compile here.
 */
export async function preload(voiceId: string): Promise<void> {
  const { model, config } = voiceUrls(voiceId);
  await pullThrough([model, config], 'voice');
}

/** Whether the piper/ONNX wasm has already been downloaded. */
export async function isRuntimeCached(): Promise<boolean> {
  return hasStep('text-to-speech-runtime', RUNTIME_KEY);
}

/**
 * Whether the voice's model and config are both in the service worker's
 * cache, i.e. usable without a download. Only reads storage; never fetches.
 *
 * Asks after the files themselves rather than a step marker: there are only
 * two, their URLs are known without loading anything, and a cache entry can't
 * be there unless its whole body was written.
 */
export async function isCached(voiceId: string): Promise<boolean> {
  const { model, config } = voiceUrls(voiceId);
  const [hasModel, hasConfig] = await Promise.all([
    hasAsset(model),
    hasAsset(config),
  ]);
  return hasModel && hasConfig;
}
