/**
 * Browser-based speech-to-text using Whisper via Transformers.js. Runs in a
 * dedicated Web Worker (WebGPU if available, falling back to WASM).
 */

import { toMonoPcm } from '../audio/decode';
import { hasWarmRuntime } from '../runtime-cache';
import type { LoadProgress, ProgressCallback } from '../progress';
import type { WorkerRequest, WorkerResponse } from './messages';
import { ORT_RUNTIME_MARKER_KEY } from './runtime';

const SAMPLE_RATE = 16000;

// Transformers.js caches every file it downloads in the Cache Storage under
// `env.cacheKey`, keyed by the full remote URL it fetched them from.
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
// Whisper needs an encoder and a (merged) decoder, so a ready model means at
// least two weight files. Matching on the model prefix rather than exact
// filenames keeps this working if the dtype or file layout changes.
const MODEL = 'onnx-community/whisper-base';
const MIN_CACHED_WEIGHTS = 2;

export interface TranscribeOptions {
  /**
   * Source language. Pass 'english' or 'spanish' to force that language
   * (recommended — it's faster and more accurate than auto-detection).
   * Omit to let Whisper auto-detect the language instead.
   */
  language?: 'english' | 'spanish' | (string & {});
  /** 'transcribe' keeps original language; 'translate' converts to English. */
  task?: 'transcribe' | 'translate';
}

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressCallback;
}

// One long-lived worker for the session, so the compiled pipeline it holds
// is only built once. Created lazily (not at module scope) since this module
// is also evaluated during prerendering, where `Worker` doesn't exist.
let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

// Set once a 'done' response has come back at least once, so `isCached()`
// can short-circuit without asking the worker.
let pipelineReady = false;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const request = pending.get(message.id);
        if (!request) return;

        if (message.type === 'progress') {
          request.onProgress?.(message.progress as LoadProgress);
        } else if (message.type === 'done') {
          pipelineReady = true;
          pending.delete(message.id);
          request.resolve(message.text ?? '');
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

function send(
  request: WorkerRequest,
  onProgress?: ProgressCallback,
): Promise<string> {
  return new Promise((resolve, reject) => {
    pending.set(request.id, { resolve, reject, onProgress });
    getWorker().postMessage(request);
  });
}

/** Transcribes an audio file/blob/buffer to text using Whisper, entirely in-browser. */
export async function transcribe(
  audio: File | Blob | ArrayBuffer | Float32Array,
  options: TranscribeOptions = {},
): Promise<string> {
  const { language, task = 'transcribe' } = options;

  // Audio decoding relies on AudioContext/OfflineAudioContext, which are
  // Window-only APIs (not exposed in workers), so it has to happen here.
  const audioData = await toMonoPcm(audio, SAMPLE_RATE);

  return send({
    id: nextRequestId++,
    mode: 'transcribe',
    audio: audioData,
    language,
    task,
  });
}

/**
 * Downloads the ONNX Runtime wasm that the pipeline runs on. Reported as its
 * own preload step because it's tens of megabytes and, unlike the model
 * weights, Transformers.js fetches it without reporting any progress.
 */
export async function preloadRuntime(
  onProgress?: ProgressCallback,
): Promise<void> {
  await send({ id: nextRequestId++, mode: 'runtime' }, onProgress);
}

/** Warms up the Whisper model cache so the first real `transcribe()` call is instant. */
export async function preload(onProgress?: ProgressCallback): Promise<void> {
  await send({ id: nextRequestId++, mode: 'preload' }, onProgress);
}

/** Whether the ONNX Runtime wasm has already been downloaded. */
export async function isRuntimeCached(): Promise<boolean> {
  if (pipelineReady) return true;
  return hasWarmRuntime(ORT_RUNTIME_MARKER_KEY);
}

/**
 * Whether the model is ready to use without a download — either the pipeline
 * is already live in this session's worker, or its weights are in the Cache
 * Storage. Only reads the cache; never fetches.
 */
export async function isCached(): Promise<boolean> {
  if (pipelineReady) return true;
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
  const requests = await cache.keys();

  // The ONNX runtime's WASM binaries live in this cache too, hence the
  // model-prefix filter.
  const weights = requests.filter(
    (req) => req.url.includes(`/${MODEL}/`) && req.url.endsWith('.onnx'),
  );

  return weights.length >= MIN_CACHED_WEIGHTS;
}
