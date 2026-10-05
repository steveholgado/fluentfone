/**
 * Shared between worker.ts, which builds the pipeline, and index.ts, which
 * uses modelKey() to key the step marker — so a model, revision or precision
 * change misses the old marker rather than matching it.
 */

import { HAS_WEBGPU, supportsShaderF16 } from '#/lib/device';

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
 * WebGPU gets an unquantized encoder and a q4 decoder. q8 runs there, but
 * slowly — measured on whisper-base at ~3.2 s per utterance against ~0.4 s
 * for this split, which is Transformers.js' own recommendation for Whisper on
 * WebGPU. Most likely ORT's WebGPU EP doesn't take q8's quantized ops and runs
 * them on the CPU, paying a GPU↔CPU round trip every decoder step. The cost is
 * size: more than twice q8's, because q4 quantizes only the MatMuls and leaves
 * the large token embedding at full precision where q8 shrinks it too.
 *
 * The encoder is fp16 where the GPU has `shader-f16`, and fp32 only where it
 * hasn't: half the size (177 MB against 353 MB at this revision), and so half
 * the download, half the copy held while its session is built, and half the
 * GPU memory it takes. (The wasm heap no longer holds it either way: see
 * EXTERNAL_WEIGHTS.) The decoder is the same either way, since this
 * revision has no fp16 build of the q4 one (`q4f16`).
 *
 * The wasm CPU path keeps q8, which is what that EP is built for. The app
 * requires WebGPU (see `lib/device`), so that path is a fallback rather than
 * one any supported device takes.
 */
export async function modelDtype() {
  if (!HAS_WEBGPU) return 'q8' as const;
  return {
    encoder_model: (await supportsShaderF16()) ? 'fp16' : 'fp32',
    decoder_model_merged: 'q4',
  } as const;
}

/**
 * Identifies the weights this device loads, for the step marker, e.g.
 * `onnx-community/whisper-small@36050c4…:fp16+q4`. A device that moves to
 * other weights — fp16 on a GPU that had been loading fp32 — misses its old
 * marker and downloads them.
 */
export async function modelKey(): Promise<string> {
  const dtype = await modelDtype();
  return `${MODEL}@${MODEL_REVISION}:${
    typeof dtype === 'string' ? dtype : Object.values(dtype).join('+')
  }`;
}

/**
 * Whether Whisper's weights are handed to ORT as external data on WebGPU,
 * which keeps them out of the worker's wasm heap (see external-weights.ts).
 * Measured with the fp16 encoder and q4 decoder, it takes the worker's wasm
 * heap from ~1.1 GB to ~35 MB with transcription time unchanged.
 * False loads the models exactly as Transformers.js does on its own.
 */
export const EXTERNAL_WEIGHTS = true;

/** What Whisper expects its input resampled to. */
export const SAMPLE_RATE = 16000;
