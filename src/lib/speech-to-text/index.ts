/**
 * Browser-based speech-to-text using Whisper via Transformers.js. Runs in a
 * dedicated Web Worker (WebGPU if available, falling back to WASM).
 */

import { toMonoPcm } from '#/lib/audio';
import { hasStep, markStep } from '#/lib/cache/markers';
import { SAMPLE_RATE, modelKey } from './constants';
import type { SttRequest, WorkerRequest, WorkerResponse } from './messages';
import type { TranscribeOptions } from './types';

export type {
  TranscribeDevice,
  TranscribeOptions,
  TranscribeTimings,
} from './types';

type DoneResponse = Extract<WorkerResponse, { type: 'done' }>;

interface PendingRequest {
  resolve: (response: DoneResponse) => void;
  reject: (err: Error) => void;
}

// One long-lived worker for the session, so the compiled pipeline it holds
// is only built once. Created lazily (not at module scope) since this module
// is also evaluated during prerendering, where `Worker` doesn't exist.
let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

// Set once the pipeline has been built — by `load()` or a transcription — so
// `isCached()` can short-circuit without touching storage.
let pipelineReady = false;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'speech-to-text',
    });

    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const request = pending.get(message.id);
        if (!request) return;

        if (message.type === 'done') {
          pending.delete(message.id);
          request.resolve(message);
        } else if (message.type === 'error') {
          pending.delete(message.id);
          request.reject(new Error(message.message));
        }
      },
    );

    worker.addEventListener('error', (event) => {
      const err = new Error(event.message || 'Speech-to-text worker failed.');
      for (const request of pending.values()) request.reject(err);
      pending.clear();
    });
  }
  return worker;
}

function send(request: SttRequest): Promise<DoneResponse> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...request, id } satisfies WorkerRequest);
  });
}

/** Transcribes an audio file/blob/buffer to text using Whisper, entirely in-browser. */
export async function transcribe(
  audio: File | Blob | ArrayBuffer | Float32Array,
  options: TranscribeOptions = {},
): Promise<string> {
  const { language, task = 'transcribe', onTimings } = options;

  // Audio decoding relies on AudioContext/OfflineAudioContext, which are
  // Window-only APIs (not exposed in workers), so it has to happen here.
  const decodeStart = performance.now();
  const audioData = await toMonoPcm(audio, SAMPLE_RATE);
  const decode = performance.now() - decodeStart;

  const response = await send({
    mode: 'transcribe',
    audio: audioData,
    language,
    task,
  });
  pipelineReady = true;

  onTimings?.({
    decode,
    inference: response.inferenceMs ?? 0,
    device: response.device ?? 'wasm',
  });

  return response.text ?? '';
}

/**
 * Downloads Whisper — its ONNX Runtime wasm and its weights — so the
 * conversation finds them on disk. Only downloads, like the other preloads:
 * the pipeline is built by `load()` when the conversation starts.
 *
 * This is one step rather than two, unlike the other capabilities: the
 * runtime's URLs are only known once Transformers.js has loaded and chosen
 * them, in the worker, so the runtime and the weights download together and
 * share a progress bar.
 */
export async function preload(): Promise<void> {
  await send({ mode: 'preload' });
  await markStep('speech-to-text', await modelKey());
}

/**
 * Builds the pipeline, so the first `transcribe()` doesn't wait for it. Reads
 * the files off disk after a preload, and downloads them otherwise.
 */
export async function load(): Promise<void> {
  await send({ mode: 'load' });
  pipelineReady = true;
}

/**
 * Whether the model is ready to use without a download — either the pipeline
 * is already live in this session's worker, or the runtime and weights are in
 * the service worker's cache. Only reads storage; never fetches.
 */
export async function isCached(): Promise<boolean> {
  if (pipelineReady) return true;
  return hasStep('speech-to-text', await modelKey());
}
