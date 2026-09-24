/**
 * Chat configuration values.
 *
 * `sw.ts` reaches this file through `lib/cache/rules.ts`, which sizes the chat
 * step's progress bar from whichever model is configured. Keep it import-free
 * (types aside) — in particular, nothing from `@litert-lm/core`, whose 20 MB of
 * wasm must not be reachable from the service worker bundle. The library's
 * version lives in ./engine.ts for that reason.
 */

import type { SamplerParams } from './types';

export const CHAT_MODELS = {
  /** Lower-end devices — smaller/faster, less capable. */
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  /** Default — better output quality, for devices that can handle it. */
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
};

export const DEFAULT_CHAT_MODEL = CHAT_MODELS.e2b;

/** Context window the engine is created with, and keyed by. */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * The largest top-K any conversation can sample with. The engine is created
 * with it, and rejects a sampler asking for more.
 */
export const MAX_TOP_K = 64;

export const DEFAULT_SAMPLER_PARAMS: Required<
  Omit<SamplerParams, 'randomSeed'>
> = {
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
};
