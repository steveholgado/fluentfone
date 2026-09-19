/**
 * Text generation via Google's LiteRT-LM web SDK, running Gemma 4 (text-only,
 * "lean" build) locally in the browser via WebGPU.
 *
 * Docs: https://developers.google.com/edge/litert-lm/js
 * Package: @litert-lm/core (early preview — text-in / text-out only)
 */

import type {
  Engine,
  EngineSettings,
  ConversationConfig,
} from '@litert-lm/core';
import { fetchModelAsBlob, hasCachedModel } from './model-cache';
import { resolveRuntimeUrls, runtimeMarkerKey } from './runtime';
import { hasWarmRuntime, warmRuntime } from '../runtime-cache';
import type { ProgressCallback } from '../progress';

/** A single turn of prior conversation history to seed context with. */
export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

/**
 * Sampling/decoding parameters. Without these, the engine defaults to greedy
 * decoding (always picking the single most likely token), which is why
 * output is fully deterministic until you set these explicitly.
 */
export interface SamplerParams {
  /** Higher = more random/creative, lower = more focused/deterministic. Try 0.6–1.0 for chat. */
  temperature?: number;
  /** Only sample from the top K most likely tokens at each step. Try 20–64. */
  topK?: number;
  /** Nucleus sampling: only sample from tokens covering this cumulative probability. Try 0.9–0.97. */
  topP?: number;
  /** Optional seed for reproducible sampling (omit for non-reproducible randomness). */
  randomSeed?: number;
}

export interface GenerateMessageOptions {
  /**
   * The user's message content for this turn. Omit this to generate an
   * opening message driven purely by the system instruction — e.g. the very
   * first message in a new chat, before the user has typed anything.
   */
  prompt?: string;
  /** System-level instruction that sets the assistant's behavior/persona. */
  systemInstruction?: string;
  /**
   * Prior turns to give the model context, in chronological order. Include
   * every turn so far, since each call is stateless and only sees what you
   * pass in here.
   */
  history?: ChatMessage[];
  /** URL of the .litertlm model file. */
  modelUrl?: string;
  /** Max context window tokens for the engine. Defaults to 8192. */
  maxNumTokens?: number;
  /**
   * Sampling parameters controlling randomness. Defaults to a general-purpose
   * chat preset (temperature 0.8, topK 40, topP 0.95) rather than greedy
   * decoding.
   */
  samplerParams?: SamplerParams;
  /**
   * Called as the call moves between phases. Preload normally gets the model
   * and the wasm runtime onto disk ahead of time, leaving only 'compiling' and
   * 'generating' to happen here — but 'downloading' can still appear if the
   * browser evicted either since. Lets the UI say which, instead of showing
   * one undifferentiated wait.
   */
  onStage?: (stage: GenerateStage) => void;
}

export type GenerateStage = 'downloading' | 'compiling' | 'generating';

const DEFAULT_SAMPLER_PARAMS: Required<Omit<SamplerParams, 'randomSeed'>> = {
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
};

export const MODELS = {
  /** Lower-end devices — smaller/faster, less capable. */
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  /** Default — better output quality, for devices that can handle it. */
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
};

export const DEFAULT_MODEL = MODELS.e4b;

// The model blob download is cached per modelUrl, separately from the engine
// itself, so preload() can pull the file down ahead of time without paying
// the cost of compiling/initializing the engine (the "warm up") — that only
// happens once generateMessage() is actually called.
const modelBlobPromises = new Map<string, Promise<Blob>>();

function getModelBlob(
  modelUrl: string,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  let promise = modelBlobPromises.get(modelUrl);
  if (!promise) {
    promise = fetchModelAsBlob(modelUrl, onProgress);
    modelBlobPromises.set(modelUrl, promise);
  }
  return promise;
}

// The engine (and its loaded model weights) is expensive to create, so we
// cache one instance per distinct modelUrl/maxNumTokens combination and
// reuse it across calls to generateMessage() within the current page load.
const enginePromises = new Map<string, Promise<Engine>>();

function engineKey(modelUrl: string, maxNumTokens: number): string {
  return `${modelUrl}::${maxNumTokens}`;
}

function getEngine(
  modelUrl: string,
  maxNumTokens: number,
  onProgress?: ProgressCallback,
  onStage?: (stage: GenerateStage) => void,
): Promise<Engine> {
  const key = engineKey(modelUrl, maxNumTokens);
  let promise = enginePromises.get(key);
  if (!promise) {
    promise = (async () => {
      onStage?.('downloading');
      const [modelBlob, { Engine: LiteRTEngine }] = await Promise.all([
        getModelBlob(modelUrl, onProgress),
        import('@litert-lm/core'),
      ]);
      const settings: EngineSettings = {
        model: modelBlob,
        mainExecutorSettings: { maxNumTokens },
      };
      // Engine.create() loads the wasm runtime (already on disk if preload
      // ran), sets up the WebGPU device and compiles the model. Minutes of
      // work on a cold start, none of it reported by the SDK.
      onStage?.('compiling');
      return LiteRTEngine.create(settings);
    })();
    enginePromises.set(key, promise);
  }
  return promise;
}

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
  modelUrl = DEFAULT_MODEL,
  maxNumTokens = 8192,
  samplerParams,
  onStage,
}: GenerateMessageOptions = {}): Promise<string> {
  const engine = await getEngine(modelUrl, maxNumTokens, undefined, onStage);

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

// The exact shape of the response Message object isn't fully pinned down in
// the (early preview) public docs, so this extracts text defensively across
// a couple of plausible shapes rather than assuming one.
function extractText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const anyMsg = message as Record<string, unknown>;
    if (typeof anyMsg.text === 'string') return anyMsg.text;
    if (Array.isArray(anyMsg.content)) {
      return anyMsg.content
        .map((part) =>
          typeof part === 'object' && part && 'text' in part
            ? String((part as { text: unknown }).text ?? '')
            : '',
        )
        .join('');
    }
    if (typeof anyMsg.content === 'string') return anyMsg.content;
  }
  return String(message ?? '');
}

/**
 * Kicks off the model file download ahead of time, so the first call to
 * generateMessage() doesn't pay that cost. Deliberately stops short of
 * initializing the engine (the "warm up") — that's a separate, slower step
 * left for generateMessage() to do on demand, e.g. while generating the
 * greeting. Safe to call multiple times — memoized by modelUrl.
 */
export function preload(
  onProgress?: ProgressCallback,
  modelUrl: string = DEFAULT_MODEL,
): Promise<Blob> {
  return getModelBlob(modelUrl, onProgress);
}

// Memoized separately from the model blob: the runtime is shared across every
// model, and re-warming it on each call would re-download nothing but still
// cost a round trip per URL.
let runtimeWarmPromise: Promise<void> | null = null;

/**
 * Downloads the LiteRT-LM wasm runtime — tens of megabytes, from the CDN
 * baked into the library — so that Engine.create() finds it on disk rather
 * than fetching it silently mid-conversation.
 *
 * Stops short of compiling the model, which is the slow half of
 * Engine.create() and stays where it was.
 */
export function preloadRuntime(onProgress?: ProgressCallback): Promise<void> {
  runtimeWarmPromise ??= (async () => {
    const { LiteRtLm, getOrLoadGlobalLiteRtLm } =
      await import('@litert-lm/core');
    const { js, wasm } = await resolveRuntimeUrls(LiteRtLm.DEFAULT_WASM_PATH);

    await warmRuntime([js, wasm], await runtimeMarkerKey(), onProgress);

    // Instantiate it now the bytes are local. Engine.create() calls this same
    // memoizing getter with no path, which returns whatever is already
    // loading rather than complaining about a mismatch.
    await getOrLoadGlobalLiteRtLm();
  })().catch((err) => {
    // Don't cache a failure — a later attempt (or the engine itself) should
    // be free to retry.
    runtimeWarmPromise = null;
    throw err;
  });

  return runtimeWarmPromise;
}

/**
 * Whether the wasm runtime has already been downloaded. Answers from the
 * receipt alone — importing @litert-lm/core to resolve its real URLs would
 * defeat the point, since this runs during the check stage.
 */
export async function isRuntimeCached(): Promise<boolean> {
  if (runtimeWarmPromise) return true;
  return hasWarmRuntime(await runtimeMarkerKey());
}

/**
 * Whether the model is ready to use without a download — either the model
 * file is already fetched into memory this page session, an engine is
 * already live, or the file is in the Cache Storage.
 */
export async function isCached(
  modelUrl: string = DEFAULT_MODEL,
  maxNumTokens = 8192,
): Promise<boolean> {
  if (modelBlobPromises.has(modelUrl)) return true;
  if (enginePromises.has(engineKey(modelUrl, maxNumTokens))) return true;
  return hasCachedModel(modelUrl);
}

/**
 * Releases the cached engine(s) and their underlying model weights/resources.
 * A fresh engine will be lazily created again on the next generateMessage() call.
 */
export async function dispose(): Promise<void> {
  modelBlobPromises.clear();
  const promises = Array.from(enginePromises.values());
  enginePromises.clear();
  for (const enginePromise of promises) {
    const engine = await enginePromise;
    const maybeDeletable = engine as unknown as {
      delete?: () => Promise<void> | void;
    };
    if (typeof maybeDeletable.delete === 'function') {
      await maybeDeletable.delete();
    }
  }
}

export { clearModelCache } from './model-cache';
