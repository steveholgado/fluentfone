/**
 * The self-hosted wasm/data files TtsSession.create() fetches internally,
 * vendored from node_modules at dev/build time by
 * vite-plugin-vendor-wasm-assets.ts instead of piper-tts-web's default of
 * pulling them from jsDelivr/cdnjs at run time.
 *
 * piper-tts-web reports progress only for the voice model, never for these —
 * so on a first-ever load they would download several megabytes with the bar
 * frozen. Fetching them ourselves first, as their own preload step, both
 * reports the bytes and warms the HTTP cache (they're served `immutable`, see
 * public/_headers) so the library's own fetch resolves from disk.
 *
 * Shared between worker.ts, which downloads them, and index.ts, which points
 * TtsSession at them and probes whether they're already cached.
 */

export const ONNX_WASM_BASE = '/vendor/onnx/1.23.2/';
export const PIPER_WASM_BASE = '/vendor/piper-wasm/1.0.0/';

export const WASM_FILES = [
  `${ONNX_WASM_BASE}ort-wasm-simd-threaded.wasm`,
  `${PIPER_WASM_BASE}piper_phonemize.wasm`,
  `${PIPER_WASM_BASE}piper_phonemize.data`,
];

/**
 * Carries the versioned paths, so bumping either dependency invalidates the
 * old receipt rather than matching it.
 */
export const PIPER_RUNTIME_MARKER_KEY = `piper:${ONNX_WASM_BASE}:${PIPER_WASM_BASE}`;

/** Where the voice models live in OPFS, as piper-tts-web lays them out. */
export const OPFS_VOICE_DIR = 'piper';
