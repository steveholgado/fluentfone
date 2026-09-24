/**
 * Shared between worker.ts, which builds the pipeline, and index.ts, which
 * uses MODEL_KEY to key the step marker — so a model or precision change
 * misses the old marker rather than matching it.
 */

import { HAS_WEBGPU } from '#/lib/device';

export const MODEL = 'onnx-community/whisper-small';

/**
 * Selects which weight files Transformers.js downloads.
 *
 * WebGPU gets a full-precision encoder and a q4 decoder. q8 runs there, but
 * slowly — measured on whisper-base at ~3.2 s per utterance against ~0.4 s
 * for this split, which is Transformers.js' own recommendation for Whisper on
 * WebGPU. Most likely ORT's WebGPU EP doesn't take q8's quantized ops and runs
 * them on the CPU, paying a GPU↔CPU round trip every decoder step. The cost is
 * size: more than twice q8's, because q4 quantizes only the MatMuls and leaves
 * the large token embedding at full precision where q8 shrinks it too.
 *
 * The wasm CPU path keeps q8, which is what that EP is built for. The app
 * requires WebGPU (see `lib/device`), so that path is a fallback rather than
 * one any supported device takes.
 */
export const MODEL_DTYPE = HAS_WEBGPU
  ? ({ encoder_model: 'fp32', decoder_model_merged: 'q4' } as const)
  : 'q8';

/**
 * Identifies this set of weights for the step marker, e.g.
 * `onnx-community/whisper-small:fp32+q4`.
 */
export const MODEL_KEY = `${MODEL}:${
  typeof MODEL_DTYPE === 'string'
    ? MODEL_DTYPE
    : Object.values(MODEL_DTYPE).join('+')
}`;

/** What Whisper expects its input resampled to. */
export const SAMPLE_RATE = 16000;
