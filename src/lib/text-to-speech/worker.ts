/**
 * Runs one Piper voice off the main thread, for the worker's whole life — see
 * the comment at the top of index.ts for why.
 */

import type { WorkerRequest, WorkerResponse } from './messages';
import { loadVoice, synthesize, toWav, type PiperVoice } from './piper';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

let voice: Promise<PiperVoice> | null = null;
let voiceId: string | null = null;

/**
 * The worker's one voice, loaded on first use. A request for any other is a
 * mistake on the main thread's side, which opens a worker per voice, so it is
 * refused rather than served.
 *
 * A failed load is forgotten, so the next request tries again.
 */
function getVoice(requested: string): Promise<PiperVoice> {
  if (voiceId !== null && voiceId !== requested) {
    return Promise.reject(
      new Error(
        `This worker speaks ${voiceId}; ${requested} needs a worker of its own.`,
      ),
    );
  }

  voiceId = requested;

  if (!voice) {
    const loading = loadVoice(requested);
    voice = loading;
    loading.catch(() => {
      if (voice === loading) voice = null;
    });
  }

  return voice;
}

// Lines are synthesised one at a time, in the order they arrived. A caller can
// send the next line before the last has finished — a reply is spoken sentence
// by sentence as it's generated — and ORT won't run one session twice at once.
let queue: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id } = request;

  try {
    const loaded = await getVoice(request.voiceId);

    if (request.mode === 'load') {
      ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
      return;
    }

    const { wav, synthesisMs } = await inTurn(async () => {
      const synthesisStart = performance.now();
      const samples = await synthesize(
        loaded,
        request.text,
        request.lengthScale,
      );
      const wav = toWav(samples, loaded.config.audio.sample_rate);
      return { wav, synthesisMs: performance.now() - synthesisStart };
    });

    // Transfer the bytes rather than copying them.
    ctx.postMessage(
      {
        id,
        type: 'done',
        buffer: wav,
        mimeType: 'audio/wav',
        synthesisMs,
      } satisfies WorkerResponse,
      [wav],
    );
  } catch (err) {
    ctx.postMessage({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
