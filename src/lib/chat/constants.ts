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

/**
 * Pinned to a commit rather than `main`, which is a branch: a push upstream
 * would change the bytes behind an unchanged URL, and everything downstream —
 * the step marker, the sweep, the service worker's cache — takes the URL as
 * the version. Moving to a newer upload means bumping the hash here, which
 * misses the old marker and lets the sweep delete the old file.
 *
 * Get the hash with
 * `curl -s https://huggingface.co/api/models/<repo> | jq -r .sha`.
 */
export const CHAT_MODELS = {
  /** Lower-end devices — smaller/faster, less capable. */
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1/gemma-4-E2B-it-web.litertlm',
  /** Default — better output quality, for devices that can handle it. */
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/2eee7ac325f20eb8c9ac1d0e972f7c84663062da/gemma-4-E4B-it-web.litertlm',
};

export const DEFAULT_CHAT_MODEL = CHAT_MODELS.e4b;

/** Context window the engine is created with, and keyed by. */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Identifies an engine. The worker caches engines under it, and the main
 * thread mirrors which of them are warm.
 */
export function engineKey(modelUrl: string, maxNumTokens: number): string {
  return `${modelUrl}::${maxNumTokens}`;
}

/**
 * The largest top-K any conversation can sample with. The engine is created
 * with it, and rejects a sampler asking for more.
 */
export const MAX_TOP_K = 64;

export const DEFAULT_SAMPLER_PARAMS: Required<
  Omit<SamplerParams, 'randomSeed'>
> = {
  // Lower than a general chat preset: 0.8/40
  temperature: 0.6,
  topK: 20,
  topP: 0.95,
};
