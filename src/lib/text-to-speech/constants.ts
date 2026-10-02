/**
 * The voices on offer, where each one downloads from, and the self-hosted
 * wasm/data files the Piper engine runs on — vendored from node_modules at
 * dev/build time by vite-plugin-vendor-wasm-assets.ts rather than fetched from
 * a CDN at run time.
 *
 * The wasm is fetched up front, as its own preload step, rather than left for
 * the first session to pull down alongside the voice — the two would otherwise
 * share one progress bar whose total jumped when the voice download began.
 * That is cheap to do precisely because these URLs are ours: unlike the CDN
 * runtimes, there is no third-party build-variant selection to reproduce, just
 * four constant paths.
 *
 * Shared between the worker, which loads from them, and index.ts, which pulls
 * them through so the service worker stores them.
 */

import { ORT_VERSION } from '#/lib/ort';

/**
 * Piper voice IDs, grouped by locale: each group is that locale's voice pack,
 * downloaded together. Any voice in VOICE_REPO's voices.json will load, since
 * its files are found from the ID alone (see `voiceUrls`).
 */
export const VOICES = {
  en_US: ['en_US-hfc_female-medium'],
  es_ES: ['es_ES-davefx-medium'],
  es_MX: ['es_MX-ald-medium'],
} as const;

/** The Hugging Face repo the voices download from. */
export const VOICE_REPO = 'diffusionstudio/piper-voices';

/**
 * The commit of VOICE_REPO to download from, rather than `main`. A voice is two
 * files fetched separately, so following a branch risks pairing one commit's
 * model with another's config. Pinned, the URL is the version, which is what
 * `isCached` and the sweep both assume.
 *
 * Get the hash with
 * `curl -s https://huggingface.co/api/models/diffusionstudio/piper-voices | jq -r .sha`.
 */
export const VOICE_REVISION = '840e38a7e26d813bd6221b78cfbaefa3585b3f71';

/**
 * Where a voice's model and its config sidecar download from. The repo files
 * each voice by its ID's parts, `<locale>-<name>-<quality>`, under the
 * locale's language: `es_ES-davefx-medium` lives at
 * `es/es_ES/davefx/medium/es_ES-davefx-medium.onnx`.
 */
export function voiceUrls(voiceId: string): { model: string; config: string } {
  const [locale, name, quality, ...rest] = voiceId.split('-');
  if (!locale || !name || !quality || rest.length > 0) {
    throw new Error(`Not a Piper voice ID: ${voiceId}`);
  }

  const language = locale.split('_')[0];
  const model =
    `https://huggingface.co/${VOICE_REPO}/resolve/${VOICE_REVISION}/` +
    `${language}/${locale}/${name}/${quality}/${voiceId}.onnx`;

  return { model, config: `${model}.json` };
}

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
export const MIN_SPEED = 0.35;

/** The speed to repeat a line at slowly, given the speed it was spoken at. */
export function slowRepeatSpeed(speed: number): number {
  console.log('SLOW:', Math.max(MIN_SPEED, speed * SLOW_REPEAT_FACTOR));
  return Math.max(MIN_SPEED, speed * SLOW_REPEAT_FACTOR);
}

/** Self-hosted by vite-plugin-vendor-wasm-assets.ts; versioned by path. */
export const ONNX_WASM_BASE = `/vendor/onnx/${ORT_VERSION}/`;
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
