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
 * A step is one call that fetches something, with its own size estimate and
 * its own "done" marker.
 *
 * Two capabilities split their wasm runtime from their weights, because the
 * runtime is fetched by a separate call we control, and can be missing while
 * the weights are on disk. Speech-to-text does not: one request to its worker
 * fetches both its ONNX Runtime and its weights, so they arrive together as
 * one step.
 */
export type PreloadStepId =
  | 'text-to-speech-runtime'
  | 'text-to-speech'
  | 'speech-to-text'
  | 'chat-runtime'
  | 'chat';

/** Which downloads are already done, keyed by step. */
export type PreloadStatus = Record<PreloadStepId, boolean>;

/** Every step, runtimes beside the models they run, smallest first. */
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
