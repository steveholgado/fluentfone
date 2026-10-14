/**
 * Runs Whisper transcription off the main thread via Transformers.js. The
 * worker is long-lived and reused across requests: the whole point is to keep
 * the compiled pipeline (`pipelinePromise` below) resident in memory instead of
 * rebuilding it per call.
 */

import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

import { pullThrough } from '#/lib/cache/pull-through';
import { HAS_WEBGPU } from '#/lib/device';

import {
  EXTERNAL_WEIGHTS,
  MODEL,
  MODEL_BASE,
  MODEL_REVISION,
  modelDtype,
} from './constants';
import { loadWeightsExternally } from './external-weights';
import type { WorkerRequest, WorkerResponse } from './messages';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

// ORT's name for the backend the pipeline is built on.
const device = HAS_WEBGPU ? 'webgpu' : 'wasm';

type Transformers = typeof import('@huggingface/transformers');

let libraryPromise: Promise<Transformers> | null = null;

/** Transformers.js, set up the way this app runs it. */
function library(): Promise<Transformers> {
  libraryPromise ??= (async () => {
    const transformers = await import('@huggingface/transformers');
    const { env } = transformers;

    // Transformers.js would otherwise keep its own copy of every weight file
    // in a `transformers-cache` bucket of its own, on top of the one the
    // service worker already holds — the same bytes twice, and a second place
    // to ask whether they are present.
    env.useBrowserCache = false;

    // The revision goes in the URL template rather than the pipeline's
    // `revision` option, which 4.3.0 still doesn't forward everywhere: the
    // pipeline works out which files it needs before loading any, and that
    // pass fetches config.json (and probes preprocessor_config.json) off
    // `main` regardless. The sweep would then delete that copy on every visit,
    // and with it the ability to start offline. Every Hub URL the library
    // builds goes through this template, so nothing can miss it.
    env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;

    return transformers;
  })();
  return libraryPromise;
}

/**
 * Downloads everything building the pipeline would fetch, and builds nothing.
 * Building it holds both weight files whole, and more besides, which is a
 * peak the download screen has no use for: the conversation builds the
 * pipeline when it starts, reading the files back off disk.
 *
 * Every file is named by Transformers.js rather than predicted. The runtime's
 * URLs are the ones it chose when it loaded: which build of ORT's wasm to run
 * is the library's call. Anything but a URL — a blob, which the library swaps
 * in once it has the runtime — is already loaded, and there is nothing to
 * fetch. The model's files are the ones `ModelRegistry` says a pipeline needs,
 * the list `pipeline()` itself works from.
 */
async function download(): Promise<void> {
  const { env, ModelRegistry } = await library();
  const paths = env.backends.onnx.wasm?.wasmPaths;
  if (typeof paths !== 'object' || !paths.wasm || !paths.mjs) {
    throw new Error('Transformers.js named no ONNX Runtime files to download.');
  }
  const runtime = [paths.wasm, paths.mjs]
    .map(String)
    .filter((url) => url.startsWith('http'));

  const dtype = await modelDtype();
  const files = await ModelRegistry.get_pipeline_files(
    'automatic-speech-recognition',
    MODEL,
    {
      device,
      // 4.3.0 looks a session's dtype up by its session key, which for the
      // encoder is `model`, where the pipeline uses its file name,
      // `encoder_model`. Without this it names the fp32 encoder whatever was
      // asked for, and the fp16 one would download when the conversation
      // starts. Given both, a version that has fixed this reads the second.
      dtype:
        typeof dtype === 'string'
          ? dtype
          : { ...dtype, model: dtype.encoder_model },
    },
  );

  await pullThrough(
    [...runtime, ...files.map((file) => MODEL_BASE + file)],
    'Whisper',
  );
}

// Cached so the (large) model is only loaded once per worker lifetime.
let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  pipelinePromise ??= (async () => {
    const { pipeline } = await library();

    // The same module Transformers.js builds its sessions on. Only the GPU
    // gains from it: on the wasm EP the weights land in the heap either way.
    if (EXTERNAL_WEIGHTS && device === 'webgpu') {
      const { InferenceSession } = await import('onnxruntime-web/webgpu');
      loadWeightsExternally(InferenceSession);
    }

    return pipeline('automatic-speech-recognition', MODEL, {
      dtype: await modelDtype(),
      device,
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  })();
  return pipelinePromise;
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id } = request;

  try {
    if (request.mode === 'preload') {
      await download();
      ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
      return;
    }

    const transcriber = await getPipeline();

    if (request.mode === 'load') {
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
