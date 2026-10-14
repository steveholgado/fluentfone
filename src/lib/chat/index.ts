/**
 * Text generation via Google's LiteRT-LM web SDK, running Gemma 4 (text-only,
 * "lean" build) locally in the browser via WebGPU.
 *
 * Docs: https://developers.google.com/edge/litert-lm/js
 * Package: @litert-lm/core (early preview — text-in / text-out only)
 *
 * The public API of the module, and the last stop on the main thread: every
 * function here resolves its defaults and hands the work to a worker. The
 * engine and the wasm runtime live in ./engine.ts, which runs inside
 * ./worker.ts; the channel between the two threads is ./client.ts and
 * ./messages.ts; the configuration values are in ./constants.ts.
 */

// Keys the runtime's step marker, so a dependency bump misses the old marker
// rather than matching it. Imported from the package manifest, which the
// `exports` map does expose, rather than from the library itself, whose 20 MB
// of wasm must not be dragged in to answer a question about whether it is
// cached. Not in ./constants.ts either, which `sw.ts` can reach through
// `lib/cache/rules.ts` and which must therefore stay free of this package.
import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

import { hasStep, markStep } from '#/lib/cache/markers';

import { send } from './client';
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SAMPLER_PARAMS,
  engineKey,
} from './constants';
import type { GenerateMessageOptions } from './types';

export type {
  ChatMessage,
  GenerateMessageOptions,
  GenerateStage,
  SamplerParams,
} from './types';

/**
 * Which engines have finished a generate this page session, and so are warm in
 * the worker. The worker owns the engines themselves and keys them the same
 * way; this only mirrors the question `isCached` asks.
 *
 * Recorded on completion rather than on dispatch, which is the one behavioural
 * difference from when the engine lived here: an engine mid-compile no longer
 * counts as live. That is the safer direction — `isCached` saying "no" costs a
 * preload screen, saying "yes" too early would skip one.
 */
const liveEngineKeys = new Set<string>();
let runtimeReady = false;

/**
 * Generate the next model response, optionally grounded with a system
 * instruction and prior chat history.
 *
 * Call this two ways:
 * 1. Opening message: `generateMessage({ systemInstruction, trigger })` — no
 *    `prompt`/`history` yet, since the user hasn't said anything. `trigger`
 *    (optional) tells the model what to open with; it's left out of the
 *    history, so the next turn still carries on from this conversation.
 * 2. Follow-up turns: `generateMessage({ prompt: userText, systemInstruction,
 *    history })` — pass the full running history so the model has context.
 *
 * Stateless as far as callers are concerned — they own the history, and pass
 * all of it every time. Behind that, the worker keeps the last call's
 * conversation and, when the history passed is exactly what it already holds,
 * sends just the new message rather than having the model read everything
 * again. Any other history gets a fresh conversation built from it.
 */
export async function generateMessage({
  prompt,
  trigger,
  systemInstruction,
  history = [],
  modelUrl = DEFAULT_CHAT_MODEL,
  maxNumTokens = DEFAULT_MAX_TOKENS,
  samplerParams,
  onStage,
  onChunk,
}: GenerateMessageOptions = {}): Promise<string> {
  const text = await send(
    {
      mode: 'generate',
      prompt,
      trigger,
      systemInstruction,
      history,
      modelUrl,
      maxNumTokens,
      samplerParams: { ...DEFAULT_SAMPLER_PARAMS, ...samplerParams },
    },
    { onStage, onChunk },
  );

  liveEngineKeys.add(engineKey(modelUrl, maxNumTokens));

  return text;
}

/**
 * Pulls the model file down ahead of time so the first call to
 * generateMessage() doesn't pay that cost.
 *
 * Runs in the worker like everything else here, which costs nothing extra —
 * the worker module doesn't touch @litert-lm/core until an engine is actually
 * wanted — and keeps the several gigabytes of chunks it drains off the main
 * thread. The service worker still counts the bytes and broadcasts them, and a
 * BroadcastChannel is scoped to the origin rather than to a client, so the
 * preload screen hears them from here exactly as it did before.
 *
 * The step is marked whether the worker downloaded the file or found it
 * already on disk: bytes present with no marker is what an interrupted run
 * leaves behind, and the marker is what the preload screen reads.
 */
export async function preload(
  modelUrl: string = DEFAULT_CHAT_MODEL,
): Promise<void> {
  await send({ mode: 'preload', modelUrl });
  await markStep('chat', modelUrl);
}

/**
 * Loads the LiteRT-LM wasm runtime — tens of megabytes, from the CDN baked
 * into the library — so that the first generate finds it in memory rather than
 * fetching it silently mid-conversation.
 *
 * Stops short of compiling the model, the slow half of `Engine.create()`,
 * which stays where it was.
 */
export async function preloadRuntime(): Promise<void> {
  await send({ mode: 'preload-runtime' });
  await markStep('chat-runtime', LITERT_VERSION);
  runtimeReady = true;
}

/**
 * Whether the wasm runtime has already been downloaded. Keyed by package
 * version rather than by URL, since resolving the real URL would mean
 * importing @litert-lm/core — and this runs during the check stage, before the
 * user has agreed to download anything.
 *
 * Answered here rather than asked of the worker, so that the check stage
 * doesn't spawn one just to read a marker.
 */
export async function isRuntimeCached(): Promise<boolean> {
  if (runtimeReady) return true;
  return hasStep('chat-runtime', LITERT_VERSION);
}

/**
 * Whether the model is ready to use without a download — either an engine is
 * already warm in the worker this page session, or the file is in the service
 * worker's cache.
 */
export async function isCached(
  modelUrl: string = DEFAULT_CHAT_MODEL,
  maxNumTokens = DEFAULT_MAX_TOKENS,
): Promise<boolean> {
  if (liveEngineKeys.has(engineKey(modelUrl, maxNumTokens))) return true;
  return hasStep('chat', modelUrl);
}

/**
 * Frees the conversation the worker kept from the last generate, for when a
 * call ends. The next generate builds a fresh one regardless — a new call's
 * system instruction never matches the old — but until then the old one would
 * sit in memory while the next call loads its voice.
 *
 * The engine stays: it's the same model whatever the call, and compiling it
 * again would cost minutes. A generate still in flight finishes, and its
 * reply comes back, but its conversation isn't kept either.
 */
export async function endConversation(): Promise<void> {
  await send({ mode: 'end-conversation' });
}
