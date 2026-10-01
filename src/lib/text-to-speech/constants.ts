/**
 * The voices on offer, and the self-hosted wasm/data files
 * TtsSession.create() fetches internally — vendored from node_modules at
 * dev/build time by vite-plugin-vendor-wasm-assets.ts instead of
 * piper-tts-web's default of pulling them from jsDelivr/cdnjs at run time.
 *
 * The wasm is fetched up front, as its own preload step, rather than left for
 * TtsSession.create() to pull down alongside the voice — the two would
 * otherwise share one progress bar whose total jumped when the voice download
 * began. That is cheap to do precisely because these URLs are ours: unlike the
 * CDN runtimes, there is no third-party build-variant selection to reproduce,
 * just four constant paths.
 *
 * Shared between worker.ts, which points TtsSession at them, and index.ts,
 * which pulls them through so the service worker stores them.
 */

/**
 * Piper voice IDs, grouped by locale: each group is that locale's voice pack,
 * downloaded together. Full list:
 * await (await import('@mintplex-labs/piper-tts-web')).voices()
 *
 * Only IDs in that list will load — the library maps each to a file path, and
 * has no path for any other.
 */
export const VOICES = {
  en_US: ['en_US-hfc_female-medium'],
  es_ES: ['es_ES-davefx-medium'],
  es_MX: ['es_MX-ald-medium'],
} as const;

/**
 * Slower speech is synthesised rather than played back slower: Piper's
 * length_scale lengthens every phoneme and pause, which sounds like deliberate
 * speech rather than a stretched recording. A speed is its inverse, and
 * multiplies the voice's own value.
 *
 * "Repeat slowly" goes this much slower than the line was spoken, but never
 * below MIN_SPEED, past which Piper starts to drawl.
 */
export const SLOW_REPEAT_FACTOR = 2 / 3;
export const MIN_SPEED = 0.5;

/** The speed to repeat a line at slowly, given the speed it was spoken at. */
export function slowRepeatSpeed(speed: number): number {
  return Math.max(MIN_SPEED, speed * SLOW_REPEAT_FACTOR);
}

/** Self-hosted by vite-plugin-vendor-wasm-assets.ts; versioned by path. */
export const ONNX_WASM_BASE = '/vendor/onnx/1.23.2/';
export const PIPER_WASM_BASE = '/vendor/piper-wasm/1.0.0/';

/**
 * Includes the ONNX loader `.mjs`, which ORT imports for itself at session
 * time rather than during this step. Fetching it here too means a session can
 * be created with no network at all.
 */
export const WASM_FILES = [
  `${ONNX_WASM_BASE}ort-wasm-simd-threaded.wasm`,
  `${ONNX_WASM_BASE}ort-wasm-simd-threaded.mjs`,
  `${PIPER_WASM_BASE}piper_phonemize.wasm`,
  `${PIPER_WASM_BASE}piper_phonemize.data`,
];

/**
 * Identifies this set of files for the step marker. Both paths carry their
 * package version, so bumping either invalidates the old marker rather than
 * matching it.
 */
export const RUNTIME_KEY = `${ONNX_WASM_BASE}|${PIPER_WASM_BASE}`;

/** Where the voice models live in OPFS, as piper-tts-web lays them out. */
export const OPFS_VOICE_DIR = 'piper';
