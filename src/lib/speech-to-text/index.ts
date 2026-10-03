/**
 * Browser-based speech-to-text using Whisper via Transformers.js. Runs in a
 * dedicated Web Worker (WebGPU if available, falling back to WASM).
 */

import { toMonoPcm } from '#/lib/audio';
import { hasStep, markStep } from '#/lib/cache/markers';
import { SAMPLE_RATE, modelKey } from './constants';
import type { WorkerRequest, WorkerResponse } from './messages';
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

// Set once a 'done' response has come back at least once, so `isCached()`
// can short-circuit without touching storage.
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
          pipelineReady = true;
          pending.delete(message.id);
          request.resolve(message);
        } else if (message.type === 'error') {
          pending.delete(message.id);
          request.reject(new Error(message.message));
        }
      },
    );

    worker.addEventListener('error', (err) => {
      for (const [id, request] of pending) {
        request.reject(err instanceof Error ? err : new Error(String(err)));
        pending.delete(id);
      }
    });
  }
  return worker;
}

function send(request: WorkerRequest): Promise<DoneResponse> {
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject });
    getWorker().postMessage(request);
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
    id: nextRequestId++,
    mode: 'transcribe',
    audio: audioData,
    language,
    task,
  });

  onTimings?.({
    decode,
    inference: response.inferenceMs ?? 0,
    device: response.device ?? 'wasm',
  });

  return response.text ?? '';
}

/**
 * Warms up the Whisper model cache so the first real `transcribe()` call is
 * instant.
 *
 * This is one step rather than two, unlike the other capabilities: nothing in
 * the Transformers.js API downloads its ONNX Runtime wasm without also
 * building the pipeline, so the runtime and the weights arrive together and
 * share a progress bar. Splitting them again would mean predicting the wasm
 * URLs — reproducing a build-variant choice that is Transformers.js' to make.
 */
export async function preload(): Promise<void> {
  await send({ id: nextRequestId++, mode: 'preload' });
  await markStep('speech-to-text', await modelKey());
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
