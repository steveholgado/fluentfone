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
// The only part of @litert-lm/core the check stage is allowed to pull in. It
// keys the runtime marker, so a dependency bump misses the old one rather than
// matching it — and it comes from the package manifest, which the `exports`
// map does expose, rather than from the library itself, whose 20 MB of wasm
// must not be dragged in to answer a question about whether it is cached.
import { version as LITERT_VERSION } from '@litert-lm/core/package.json';
import { DEFAULT_CHAT_MODEL, hasAsset, hasStep, markStep } from '../assets';

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
   * Called as the call moves between phases, so the UI can say which one it is
   * waiting on instead of showing one undifferentiated wait.
   *
   * Preload normally gets the model and the wasm runtime onto disk ahead of
   * time, so the usual sequence is 'loading' (reading the file back off disk),
   * 'compiling', 'generating'. 'downloading' appears in its place only when
   * the bytes really are being fetched — a first run that skipped preload, or
   * a browser that has evicted them since.
   */
  onStage?: (stage: GenerateStage) => void;
}

export type GenerateStage =
  'downloading' | 'loading' | 'compiling' | 'generating';

const DEFAULT_SAMPLER_PARAMS: Required<Omit<SamplerParams, 'randomSeed'>> = {
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
};

/**
 * The LiteRT-LM web SDK (early preview) doesn't persist a downloaded model
 * across page loads and `Engine.create()` takes a Blob rather than a URL, so
 * the file is fetched here and handed over.
 *
 * Nothing is memoized. The service worker holds the bytes, so a second fetch
 * is a cache read rather than a download — and keeping a multi-gigabyte Blob
 * alive for the whole session to avoid it would be a poor trade.
 */
async function fetchModel(modelUrl: string): Promise<Blob> {
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download model (${response.status}): ${modelUrl}`,
    );
  }
  return response.blob();
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
  onStage?: (stage: GenerateStage) => void,
): Promise<Engine> {
  const key = engineKey(modelUrl, maxNumTokens);
  let promise = enginePromises.get(key);
  if (!promise) {
    promise = (async () => {
      // Which wait this is, asked of the cache rather than assumed. fetchModel
      // cannot tell a network download from a cache hit — both are a `fetch`
      // the service worker answers — and on a return visit calling it a
      // download misreported a disk read of several gigabytes as a fresh one.
      onStage?.((await hasAsset(modelUrl)) ? 'loading' : 'downloading');

      const [modelBlob, { Engine: LiteRTEngine }] = await Promise.all([
        fetchModel(modelUrl),
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
  modelUrl = DEFAULT_CHAT_MODEL,
  maxNumTokens = 8192,
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

// Memoized because the runtime is shared across every model, and a repeat call
// would re-download nothing but still cost a round trip per URL.
let runtimeWarmPromise: Promise<void> | null = null;

/**
 * Loads the LiteRT-LM wasm runtime — tens of megabytes, from the CDN baked
 * into the library — so that Engine.create() finds it in memory rather than
 * fetching it silently mid-conversation.
 *
 * The library picks between four wasm builds by feature detection and fetches
 * the winner itself. We used to reproduce that choice in order to prefetch the
 * right file; now the service worker recognises whichever one it asks for, so
 * this just asks the library to load, and stops short of compiling the model —
 * the slow half of Engine.create(), which stays where it was.
 */
export function preloadRuntime(): Promise<void> {
  runtimeWarmPromise ??= (async () => {
    const { getOrLoadGlobalLiteRtLm } = await import('@litert-lm/core');

    // Engine.create() calls this same memoizing getter, which returns whatever
    // is already loading rather than starting a second copy.
    await getOrLoadGlobalLiteRtLm();

    await markStep('chat-runtime', LITERT_VERSION);
  })().catch((err) => {
    // Don't cache a failure — a later attempt (or the engine itself) should
    // be free to retry.
    runtimeWarmPromise = null;
    throw err;
  });

  return runtimeWarmPromise;
}

/**
 * Whether the wasm runtime has already been downloaded. Keyed by package
 * version rather than by URL, since resolving the real URL would mean
 * importing @litert-lm/core — and this runs during the check stage, before the
 * user has agreed to download anything.
 */
export async function isRuntimeCached(): Promise<boolean> {
  if (runtimeWarmPromise) return true;
  return hasStep('chat-runtime', LITERT_VERSION);
}

/**
 * Whether the model is ready to use without a download — either an engine is
 * already live this page session, or the file is in the service worker's
 * cache.
 */
export async function isCached(
  modelUrl: string = DEFAULT_CHAT_MODEL,
  maxNumTokens = 8192,
): Promise<boolean> {
  if (enginePromises.has(engineKey(modelUrl, maxNumTokens))) return true;
  return hasStep('chat', modelUrl);
}

/**
 * Releases the cached engine(s) and their underlying model weights/resources.
 * A fresh engine will be lazily created again on the next generateMessage() call.
 */
export async function dispose(): Promise<void> {
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
