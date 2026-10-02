/**
 * Which downloads belong to which preload step, and roughly how big they are.
 * The service worker stores and counts everything a rule matches.
 *
 * `lib/cache` is the bottom of the import graph on purpose. Both `sw.ts` and
 * the page import from it, so every file in this folder may import only from
 * dependency-free leaf modules — currently `preload/steps.ts` (type-only) and
 * `chat/constants.ts`. Nothing that touches a library, a worker, or the DOM.
 */

import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from '#/lib/chat/constants';
import type { PreloadStepId } from '#/lib/preload/steps';

export interface AssetRule {
  step: PreloadStepId;
  /** Recognises the step's downloads wherever they are issued from. */
  matches: (url: URL) => boolean;
}

/**
 * Deliberately coarse patterns rather than exact URLs. The whole point of
 * letting the libraries fetch their own wasm is that we stop reproducing their
 * build-variant selection logic, so these must match every variant a browser
 * might pick.
 */
export const ASSET_RULES: AssetRule[] = [
  {
    step: 'text-to-speech-runtime',
    matches: (url) => url.pathname.startsWith('/vendor/'),
  },
  {
    step: 'text-to-speech',
    matches: (url) =>
      url.hostname === 'huggingface.co' &&
      url.pathname.includes('piper-voices'),
  },
  {
    step: 'speech-to-text',
    matches: (url) =>
      (url.hostname === 'cdn.jsdelivr.net' &&
        url.pathname.includes('onnxruntime-web@')) ||
      (url.hostname === 'huggingface.co' &&
        url.pathname.includes('onnx-community/whisper')),
  },
  {
    step: 'chat-runtime',
    matches: (url) =>
      url.hostname === 'cdn.jsdelivr.net' &&
      url.pathname.includes('@litert-lm/core@'),
  },
  {
    step: 'chat',
    matches: (url) =>
      url.hostname === 'huggingface.co' &&
      url.pathname.includes('litert-community'),
  },
];

export function ruleFor(url: URL): AssetRule | undefined {
  return ASSET_RULES.find((rule) => rule.matches(url));
}

/**
 * Roughly what each step downloads, used only as a floor for the progress
 * bar's denominator.
 *
 * The service worker learns a file's real size when its headers arrive, which
 * for a multi-file step is *after* the bar has already started moving — and
 * the bar never moves backwards, so a denominator that grew mid-step would
 * strand it. Starting from an estimate avoids that.
 *
 * Being wrong is cheap in both directions: too low and the observed total wins
 * (see `trackStep`), too high and the bar finishes a little short before the
 * step's terminal 100% snaps it up. Refresh on a dependency bump by taking the
 * Content-Length of each file.
 *
 * Every step needs an entry, which is why this is a total record rather than a
 * partial one: the estimate is the progress bar's floor, so a step without one
 * could report no denominator at all if its responses declared no length.
 * Adding a `PreloadStepId` without a figure here is a type error, by design.
 *
 * The text-to-speech figure is per voice. Every voice in VOICES is a piper
 * "medium", and those happen to be the same size, so it holds for any of them
 * — but a voice at another quality, or with more than one speaker, would need
 * a new figure.
 */
export const EXPECTED_BYTES: Record<PreloadStepId, number> = {
  'text-to-speech-runtime': 33_002_000,
  'text-to-speech': 63_206_000,
  // whisper-small's WebGPU weights (see speech-to-text/constants.ts), since the
  // app requires WebGPU.
  'speech-to-text': 615_659_000,
  'chat-runtime': 20_140_000,
  // Unlike the others this is a single file, so its Content-Length is normally
  // known before the first byte and this estimate goes unused. It is here for
  // the case where it isn't: a response that declares no length would
  // otherwise leave the longest download in the app with no denominator at all
  // and a bar that cannot move. Keyed off which model is actually configured,
  // since the two differ by a third.
  chat: DEFAULT_CHAT_MODEL === CHAT_MODELS.e2b ? 2_008_432_000 : 2_969_059_000,
};
