/**
 * Shared between worker.ts, which builds the pipeline, and index.ts, which
 * uses MODEL_KEY to key the step marker — so a model, revision or precision
 * change misses the old marker rather than matching it.
 */

import { HAS_WEBGPU } from '#/lib/device';

export const MODEL = 'onnx-community/whisper-small';

/**
 * The commit of MODEL to download from, rather than Transformers.js' default
 * of `main`. The weights are several files fetched separately, so following a
 * branch risks an interrupted download resuming against a newer commit and
 * pairing one commit's encoder with another's decoder. Pinned, the URL is the
 * version, which is what the step marker and the sweep both assume.
 *
 * Get the hash with
 * `curl -s https://huggingface.co/api/models/onnx-community/whisper-small | jq -r .sha`.
 */
export const MODEL_REVISION = '36050c46d777d46dc4b5f43f6d90574fc38f8732';

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
 * `onnx-community/whisper-small@36050c4…:fp32+q4`.
 */
export const MODEL_KEY = `${MODEL}@${MODEL_REVISION}:${
  typeof MODEL_DTYPE === 'string'
    ? MODEL_DTYPE
    : Object.values(MODEL_DTYPE).join('+')
}`;

/**
 * The onnxruntime-web build Transformers.js depends on, and so fetches its wasm
 * from jsDelivr under — not the app's own onnxruntime-web, which is Piper's.
 * Lets the models-cache sweep tell this runtime from one an older
 * Transformers.js left behind.
 *
 * Written out because the package doesn't export its package.json. A test
 * checks it against the installed dependency, so a Transformers.js bump that
 * changes the pin fails there rather than having the sweep delete the runtime
 * on every visit.
 */
export const TRANSFORMERS_ORT_VERSION = '1.26.0-dev.20260416-b7804b056c';

/** What Whisper expects its input resampled to. */
export const SAMPLE_RATE = 16000;
