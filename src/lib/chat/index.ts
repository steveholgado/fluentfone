/**
 * Text generation via Google's LiteRT-LM web SDK, running Gemma 4 (text-only,
 * "lean" build) locally in the browser via WebGPU.
 *
 * Docs: https://developers.google.com/edge/litert-lm/js
 * Package: @litert-lm/core (early preview — text-in / text-out only)
 *
 * The public API of the module. Engine lifecycle and the wasm runtime live in
 * ./engine.ts; the configuration values in ./constants.ts.
 */

import type { ConversationConfig } from '@litert-lm/core';
import { hasAsset, hasStep, markStep } from '#/lib/cache/markers';
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SAMPLER_PARAMS,
} from './constants';
import { extractText, getEngine, hasLiveEngine } from './engine';
import type { GenerateMessageOptions } from './types';

export { dispose, isRuntimeCached, preloadRuntime } from './engine';
export { CHAT_MODELS, DEFAULT_CHAT_MODEL } from './constants';
export type {
  ChatMessage,
  GenerateMessageOptions,
  GenerateStage,
  SamplerParams,
} from './types';

/**
 * Generate the next model response, optionally grounded with a system
 * instruction and prior chat history.
 *
 * Call this two ways:
 * 1. Opening message: `generateMessage({ systemInstruction })` — no
 *    `prompt`/`history` yet, since the user hasn't said anything.
 * 2. Follow-up turns: `generateMessage({ prompt: userText, systemInstruction,
 *    history })` — pass the full running history so the model has context.
 *
 * Each call creates a fresh Conversation seeded with the supplied history,
 * so this function is stateless between calls — callers own the history.
 */
export async function generateMessage({
  prompt,
  systemInstruction,
  history = [],
  modelUrl = DEFAULT_CHAT_MODEL,
  maxNumTokens = DEFAULT_MAX_TOKENS,
  samplerParams,
  onStage,
}: GenerateMessageOptions = {}): Promise<string> {
  const engine = await getEngine(modelUrl, maxNumTokens, onStage);

  const prefaceMessages: Array<{
    role: 'system' | 'user' | 'model';
    content: string;
  }> = [];
  if (systemInstruction) {
    prefaceMessages.push({ role: 'system', content: systemInstruction });
  }
  for (const turn of history) {
    prefaceMessages.push({ role: turn.role, content: turn.content });
  }

  const mergedSamplerParams = { ...DEFAULT_SAMPLER_PARAMS, ...samplerParams };

  const conversationConfig: ConversationConfig = {
    preface: { messages: prefaceMessages },
    // NOTE: `samplerParams` is not yet documented on the official JS API page
    // (as of writing the docs only show `preface`), but the underlying
    // engine's SessionConfig — which every platform binding maps onto —
    // carries an equivalent field. If your installed version of
    // @litert-lm/core uses a different key, check the shipped type defs.
    samplerParams: mergedSamplerParams,
  } as ConversationConfig;

  const conversation = await engine.createConversation(conversationConfig);

  onStage?.('generating');

  try {
    // The SDK requires an outbound message to elicit a response — there's no
    // documented "generate from the preface alone" call. When `prompt` is
    // omitted (the opening-message case), we send an empty trigger turn; the
    // system instruction should describe what that first message should say.
    // This trigger is NOT part of `history` — don't store it as a real turn.
    const response = await conversation.sendMessage({
      role: 'user',
      content: prompt ?? '',
    });
    return extractText(response);
  } finally {
    const maybeDeletable = conversation as unknown as {
      delete?: () => Promise<void> | void;
    };
    if (typeof maybeDeletable.delete === 'function') {
      await maybeDeletable.delete();
    }
  }
}

/**
 * Pulls the model file down ahead of time so the first call to
 * generateMessage() doesn't pay that cost. The bytes land in the service
 * worker's cache and are discarded here — `Engine.create()` re-reads them from
 * there, which is cheap, rather than this holding gigabytes for the session.
 *
 * Deliberately stops short of initializing the engine (the "warm up") — that's
 * a separate, slower step left for generateMessage() to do on demand, e.g.
 * while generating the greeting.
 */
export async function preload(
  modelUrl: string = DEFAULT_CHAT_MODEL,
): Promise<void> {
  // Alone among the preload steps this one warms nothing up: getting the bytes
  // on disk is all it does, so once they are there it has no work left. It ran
  // regardless until now, and on every return visit streamed the whole model
  // out of the cache only to discard it — against the same disk the greeting
  // was waiting on to read that very file.
  //
  // Asked of the cache rather than of the marker: the marker is what a failed
  // cache write leaves behind looking like success, and skipping the download
  // on its word is exactly the mistake that would cost the bytes.
  if (await hasAsset(modelUrl)) {
    // Written even so. The bytes being present while the marker is missing is
    // the interrupted-run case, and the marker is what the preload screen
    // reads.
    await markStep('chat', modelUrl);
    return;
  }

  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download model (${response.status}): ${modelUrl}`,
    );
  }

  // Drained, not buffered. The bytes only need to stream past the service
  // worker so it can store and count them; `arrayBuffer()` would additionally
  // demand a single contiguous ~3 GB allocation, which fails often enough that
  // the step would reject after a successful download — leaving the marker
  // unwritten and the screen still offering the download.
  await response.body?.pipeTo(new WritableStream());

  await markStep('chat', modelUrl);
}

/**
 * Whether the model is ready to use without a download — either an engine is
 * already live this page session, or the file is in the service worker's
 * cache.
 */
export async function isCached(
  modelUrl: string = DEFAULT_CHAT_MODEL,
  maxNumTokens = DEFAULT_MAX_TOKENS,
): Promise<boolean> {
  if (hasLiveEngine(modelUrl, maxNumTokens)) return true;
  return hasStep('chat', modelUrl);
}
