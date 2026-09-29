// `@mintplex-labs/piper-tts-web`'s `TtsSession` is a singleton: constructing
// another — directly or via `TtsSession.create()` — hands back the first
// (it logs "Reusing session for TTS!"), relabelled with the new voiceId but
// with the first voice's ONNX session still behind it. So within one JS realm
// a second voice silently speaks with the first one's model, and there's no
// way round that through the library's public API.
//
// The fix: every voice gets a Web Worker of its own. A worker has a completely
// separate module registry, so nothing module-scoped inside piper-tts-web is
// shared between two of them. A worker keeps its session for as long as it is
// open — a whole conversation, normally — which is safe because a conversation
// never changes voice, and speed is a per-`predict()` option rather than
// something baked into the session.
//
// Voice files are cached in OPFS, which is scoped to the origin rather than
// to a worker, so a fresh worker doesn't re-download a voice used before.

import { hasStep, markStep } from '#/lib/cache/markers';
import { trackStep } from '#/lib/preload/track';
import type { ProgressCallback } from '#/lib/progress';
import { OPFS_VOICE_DIR, RUNTIME_KEY, WASM_FILES } from './constants';
import type { TtsRequest, WorkerRequest, WorkerResponse } from './messages';
import type { SpeakOptions } from './types';

export { slowRepeatSpeed, VOICES } from './constants';
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
 * is normally silent: after preload the voice is in OPFS and nothing is
 * fetched. It only reports where the conversation was reached without a
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
        // Piper keeps a failed session as its singleton, so this worker can
        // never load one now. See worker.ts.
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

/**
 * Gets the voice into OPFS by loading it once, in a worker that's closed
 * straight after. The conversation opens a voice of its own.
 */
export async function preload(voiceId: string): Promise<void> {
  const voice = openVoice(voiceId);
  try {
    await voice.ready;
  } finally {
    voice.close();
  }
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
