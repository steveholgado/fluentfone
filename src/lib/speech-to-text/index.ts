/**
 * Browser-based speech-to-text using Whisper via Transformers.js. Runs
 * entirely client-side (WebGPU if available, falling back to WASM) — no
 * server or API key required.
 */

import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { toMonoPcm } from '../audio/decode';
import type { ProgressCallback } from '../progress';

const MODEL = 'onnx-community/whisper-base';
const SAMPLE_RATE = 16000;

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

// Cached so the (large) model is only loaded once per session.
let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getTranscriber(
  onProgress?: ProgressCallback,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('automatic-speech-recognition', MODEL, {
        dtype: 'q8',
        device:
          typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm',
        progress_callback: (data) => {
          if (onProgress && data.status === 'progress') {
            onProgress({
              loaded: data.loaded,
              total: data.total,
              progress: data.progress / 100,
            });
          }
        },
      }) as Promise<AutomaticSpeechRecognitionPipeline>;
    })();
  }
  return pipelinePromise;
}

/** Transcribes an audio file/blob/buffer to text using Whisper, entirely in-browser. */
export async function transcribe(
  audio: File | Blob | ArrayBuffer | Float32Array,
  options: TranscribeOptions = {},
): Promise<string> {
  const { language, task = 'transcribe' } = options;

  const [audioData, transcriber] = await Promise.all([
    toMonoPcm(audio, SAMPLE_RATE),
    getTranscriber(),
  ]);

  const result = await transcriber(audioData, {
    language,
    task,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const output = Array.isArray(result) ? result[0] : result;
  return (output as { text?: string })?.text?.trim() ?? '';
}

/** Warms up the Whisper model cache so the first real `transcribe()` call is instant. */
export async function preload(onProgress?: ProgressCallback): Promise<void> {
  await getTranscriber(onProgress);
}
