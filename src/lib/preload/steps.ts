/**
 * The vocabulary both tiers agree on: what a preload step is, and what order
 * the steps run in.
 *
 * Imported as a type by `lib/cache`, which attaches per-step policy (URLs,
 * sizes) to these ids, and as values by the page, which walks them. Keep it
 * free of imports — `lib/cache` must stay reachable from `sw.ts` without
 * dragging anything in.
 */

/** The three capabilities, as the preload screen lists them. */
export type PreloadLabel = 'speech-to-text' | 'chat' | 'text-to-speech';

/**
 * A step is one contiguous 0→100% run of the progress bar.
 *
 * Two capabilities split their wasm runtime from their weights, because the
 * runtime is fetched by a separate call we control and a single bar spanning
 * both would have to restart its total partway through. Speech-to-text does
 * not: nothing in the Transformers.js API downloads its ONNX Runtime without
 * also building the pipeline, so the two arrive together and share one bar.
 */
export type PreloadStepId =
  | 'text-to-speech-runtime'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'chat-runtime'
  | 'chat';

/** Which downloads are already done, keyed by step. */
export type PreloadStatus = Record<PreloadStepId, boolean>;

/** The order preloadAll downloads in — smallest first. */
export const DOWNLOAD_ORDER: PreloadStepId[] = [
  'text-to-speech-runtime',
  'text-to-speech',
  'speech-to-text',
  'chat-runtime',
  'chat',
];

/** The steps behind each label, for rolling them up in the UI. */
export const STEPS_BY_LABEL: Record<PreloadLabel, PreloadStepId[]> = {
  'text-to-speech': ['text-to-speech-runtime', 'text-to-speech'],
  'speech-to-text': ['speech-to-text'],
  chat: ['chat-runtime', 'chat'],
};
