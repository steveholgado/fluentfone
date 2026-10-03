/**
 * Piper text-to-speech: a voice's VITS model run in an onnxruntime-web
 * session, fed phoneme IDs that espeak-ng (compiled to wasm by piper-wasm)
 * makes from the text. Worker-side only — worker.ts is the one caller.
 *
 * ORT is the same build Transformers.js runs Whisper on (see lib/ort.ts), so
 * the app carries one runtime rather than one per library.
 */

import * as ort from 'onnxruntime-web/wasm';
import createPiperPhonemize from '@diffusionstudio/piper-wasm/build/piper_phonemize.js';
import { ONNX_WASM_BASE, PIPER_WASM_BASE, voiceUrls } from './constants';

// Our copy rather than ORT's default of a sibling of its own bundle, which the
// build drops (see vite-plugin-drop-bundled-onnx-wasm.ts).
ort.env.wasm.wasmPaths = ONNX_WASM_BASE;

// This page isn't cross-origin isolated, so ORT can't run more than one thread
// anyway. It would work that out for itself, but only after logging two
// warnings on every session.
ort.env.wasm.numThreads = 1;

/** The fields of a voice's `.onnx.json` sidecar that synthesis reads. */
export interface VoiceConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  /** Empty, or absent, for a voice with a single speaker. */
  speaker_id_map?: Record<string, number>;
}

export interface PiperVoice {
  config: VoiceConfig;
  session: ort.InferenceSession;
}

async function download(url: string, what: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${what} (${response.status}): ${url}`);
  }
  return response;
}

/**
 * Fetches a voice and builds its session. The fetches go through the service
 * worker like every other model's, so a voice that has been preloaded comes
 * off disk.
 */
export async function loadVoice(voiceId: string): Promise<PiperVoice> {
  const urls = voiceUrls(voiceId);
  const [config, model] = await Promise.all([
    download(urls.config, 'voice').then(
      (r) => r.json() as Promise<VoiceConfig>,
    ),
    download(urls.model, 'voice').then((r) => r.arrayBuffer()),
  ]);

  const session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
  });

  return { config, session };
}

/**
 * espeak-ng's data, fetched once per worker and lent to every phonemizer.
 * Emscripten mounts a package it is handed as views of that buffer rather
 * than copies, and espeak only reads it, so one copy serves them all. Left to
 * fetch their own, each phonemizer held a further 18 MB until it was
 * collected — several at once, over a reply of several sentences.
 *
 * A failed fetch is forgotten, so the next call tries again.
 */
let phonemizerData: Promise<ArrayBuffer> | null = null;

function loadPhonemizerData(): Promise<ArrayBuffer> {
  if (!phonemizerData) {
    const loading = download(
      `${PIPER_WASM_BASE}piper_phonemize.data`,
      'phonemizer data',
    ).then((r) => r.arrayBuffer());
    phonemizerData = loading;
    loading.catch(() => {
      if (phonemizerData === loading) phonemizerData = null;
    });
  }
  return phonemizerData;
}

/**
 * Turns text into the phoneme IDs a voice's model reads, using the espeak-ng
 * voice the model was trained against.
 *
 * Starts a fresh phonemizer per call, as piper-tts-web did. Reusing one gives
 * the same output, but every run of `main` leaks a little of the module's
 * fixed 16 MB heap, and it traps after 80 to 90 runs — measured under Node,
 * the number depending on the text. What each call does share is espeak's
 * data, above.
 */
export async function phonemize(
  text: string,
  espeakVoice: string,
): Promise<number[]> {
  let output: string | undefined;
  const errors: string[] = [];

  const data = await loadPhonemizerData();
  const phonemizer = await createPiperPhonemize({
    print: (line) => (output ??= line),
    printErr: (line) => errors.push(line),
    locateFile: (path) =>
      path.endsWith('.wasm') ? `${PIPER_WASM_BASE}piper_phonemize.wasm` : path,
    getPreloadedPackage: () => data,
  });

  // Synchronous: the build has no Asyncify, so anything the program prints
  // has been printed by the time this returns.
  phonemizer.callMain([
    '-l',
    espeakVoice,
    '--input',
    JSON.stringify([{ text }]),
    '--espeak_data',
    '/espeak-ng-data',
  ]);

  if (output === undefined) {
    throw new Error(
      `Phonemizer produced no output${errors.length > 0 ? `: ${errors.join('\n')}` : '.'}`,
    );
  }

  return (JSON.parse(output) as { phoneme_ids: number[] }).phoneme_ids;
}

/**
 * Speaks `text` in `voice`, as mono samples at the voice's own sample rate.
 *
 * `lengthScale` multiplies the voice's own: above 1 is slower, by lengthening
 * every phoneme and pause rather than stretching the audio afterwards.
 */
export async function synthesize(
  voice: PiperVoice,
  text: string,
  lengthScale = 1,
): Promise<Float32Array> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('No text to speak.');

  const ids = await phonemize(trimmed, voice.config.espeak.voice);
  const { noise_scale, length_scale, noise_w } = voice.config.inference;

  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [
      1,
      ids.length,
    ]),
    input_lengths: new ort.Tensor(
      'int64',
      BigInt64Array.of(BigInt(ids.length)),
      [1],
    ),
    scales: new ort.Tensor(
      'float32',
      Float32Array.of(noise_scale, length_scale * lengthScale, noise_w),
      [3],
    ),
  };

  // A multi-speaker model takes which speaker as an input too. Every voice on
  // offer has one, so this is the first.
  if (Object.keys(voice.config.speaker_id_map ?? {}).length > 0) {
    feeds.sid = new ort.Tensor('int64', BigInt64Array.of(0n), [1]);
  }

  const { output } = await voice.session.run(feeds);
  return output.data as Float32Array;
}

/** Wraps mono samples in a 16-bit PCM WAV file. */
export function toWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const HEADER_BYTES = 44;
  const dataBytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(HEADER_BYTES + dataBytes));

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  samples.forEach((sample, i) => {
    const value =
      sample >= 1 ? 32767 : sample <= -1 ? -32768 : (sample * 32768) | 0;
    view.setInt16(HEADER_BYTES + i * 2, value, true);
  });

  return view.buffer;
}
