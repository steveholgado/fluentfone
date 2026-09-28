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
import { HAS_WEBGPU } from '#/lib/device';
import { MODEL, MODEL_DTYPE, MODEL_REVISION } from './constants';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

// ORT's name for the backend: what the pipeline is built on, and what each
// transcription reports it ran on.
const device = HAS_WEBGPU ? 'webgpu' : 'wasm';

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

        // The revision goes in the URL template rather than the pipeline's
        // `revision` option, which 4.2.0 doesn't forward everywhere: the
        // pipeline works out which files it needs before loading any, and that
        // pass fetches config.json (and probes preprocessor_config.json) off
        // `main` regardless. The sweep would then delete that copy on every
        // visit, and with it the ability to start offline. Every Hub URL the
        // library builds goes through this template, so nothing can miss it.
        env.remotePathTemplate = `{model}/resolve/${MODEL_REVISION}/`;

        return pipeline('automatic-speech-recognition', MODEL, {
          dtype: MODEL_DTYPE,
          device,
          // Any browser without WebGPU lands on the wasm CPU EP — where ORT's
          // extended (level 2) optimizer rewrites the decoder's QDQ pattern
          // into MatMulNBits and then throws on this q8 export:
          //
          //   qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits
          //   Missing required scale: model.decoder.embed_tokens.weight_merged_0_scale
          //
          // Whisper ties embed_tokens to lm_head, so that one quantized weight
          // has two DequantizeLinear consumers — the case the fusion mishandles
          // in the onnxruntime-web build transformers.js 4.2.0 pins
          // (1.26.0-dev.20260416; regressed in 1.25, fixed upstream by
          // microsoft/onnxruntime#28326). Capping at 'basic' skips that pass
          // and leaves constant folding and the level-1 fusions in place.
          //
          // Safari is how this surfaces in practice, but not because Safari
          // lacks WebGPU outright — it shipped in Safari 26. It's gated on the
          // OS: WebGPU is only on by default on macOS Tahoe 26+ and iOS 26+, so
          // Safari on Sequoia or Sonoma has no navigator.gpu whatever its
          // version (WebKit #299237). Those users take this branch; Safari on
          // Tahoe behaves like Chrome and does not.
          //
          // Scoped to wasm so WebGPU keeps its level-2 fusions, which is where
          // they actually pay for themselves. Drop the condition, not the
          // option, if a WebGPU browser ever hits the same error.
          ...(device === 'wasm' && {
            session_options: { graphOptimizationLevel: 'basic' as const },
          }),
        }) as Promise<AutomaticSpeechRecognitionPipeline>;
      })();
    }

    const transcriber = await pipelinePromise;

    if (request.mode === 'preload') {
      ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
      return;
    }

    const { audio, language, task = 'transcribe' } = request;

    const inferenceStart = performance.now();
    const result = await transcriber(audio, {
      language,
      task,
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const inferenceMs = performance.now() - inferenceStart;

    const output = Array.isArray(result) ? result[0] : result;
    const text = (output as { text?: string })?.text?.trim() ?? '';

    ctx.postMessage({
      id,
      type: 'done',
      text,
      inferenceMs,
      device,
    } satisfies WorkerResponse);
  } catch (err) {
    ctx.postMessage({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
