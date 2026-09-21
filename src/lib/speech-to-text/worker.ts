/**
 * Runs Whisper transcription off the main thread via Transformers.js. Unlike
 * text-to-speech/worker.ts, this worker is long-lived and reused across
 * requests: the whole point is to keep the compiled pipeline (`pipelinePromise`
 * below) resident in memory instead of rebuilding it per call. Don't copy the
 * "spawn a worker per call and terminate it" pattern from the TTS worker here
 * — that exists to work around a piper-tts-web caching bug that doesn't apply
 * to Transformers.js.
 */

import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { WorkerRequest, WorkerResponse } from './messages';
import { MODEL, MODEL_DTYPE } from './model';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

// Cached so the (large) model is only loaded once per worker lifetime.
let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id } = request;

  try {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');

        // Transformers.js would otherwise keep its own copy of every weight
        // file in a `transformers-cache` bucket of its own, on top of the one
        // the service worker already holds — the same bytes twice, and a
        // second place to ask whether they are present.
        env.useBrowserCache = false;

        return pipeline('automatic-speech-recognition', MODEL, {
          dtype: MODEL_DTYPE,
          device:
            typeof navigator !== 'undefined' && navigator.gpu
              ? 'webgpu'
              : 'wasm',
        }) as Promise<AutomaticSpeechRecognitionPipeline>;
      })();
    }

    const transcriber = await pipelinePromise;

    if (request.mode === 'preload') {
      ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
      return;
    }

    const { audio, language, task = 'transcribe' } = request;

    const result = await transcriber(audio, {
      language,
      task,
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const output = Array.isArray(result) ? result[0] : result;
    const text = (output as { text?: string })?.text?.trim() ?? '';

    ctx.postMessage({ id, type: 'done', text } satisfies WorkerResponse);
  } catch (err) {
    ctx.postMessage({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
