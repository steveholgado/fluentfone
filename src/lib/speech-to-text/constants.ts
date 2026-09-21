/**
 * Shared between worker.ts, which builds the pipeline, and index.ts, which
 * uses this to key the step marker — so a model or precision change misses the
 * old marker rather than matching it.
 */

export const MODEL = 'onnx-community/whisper-base';

/** Selects which weight files Transformers.js downloads. */
export const MODEL_DTYPE = 'q8';

export const MODEL_KEY = `${MODEL}:${MODEL_DTYPE}`;

/** What Whisper expects its input resampled to. */
export const SAMPLE_RATE = 16000;
