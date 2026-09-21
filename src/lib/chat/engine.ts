/**
 * Engine lifecycle and the LiteRT-LM wasm runtime behind it: creating engines,
 * keeping them warm, and answering what is already on disk.
 *
 * The conversational API that uses all this lives in ./index.ts.
 */

import type { Engine, EngineSettings } from '@litert-lm/core';
// The only part of @litert-lm/core the check stage is allowed to pull in. It
// keys the runtime marker, so a dependency bump misses the old one rather than
// matching it — and it comes from the package manifest, which the `exports`
// map does expose, rather than from the library itself, whose 20 MB of wasm
// must not be dragged in to answer a question about whether it is cached.
//
// Kept here rather than in ./constants.ts, which `sw.ts` can reach through
// `lib/cache/rules.ts` and which must therefore stay free of this package.
import { version as LITERT_VERSION } from '@litert-lm/core/package.json';
import { hasAsset, hasStep, markStep } from '#/lib/cache/markers';
import type { GenerateStage } from './types';

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

/** Whether an engine for this combination is already live this page session. */
export function hasLiveEngine(modelUrl: string, maxNumTokens: number): boolean {
  return enginePromises.has(engineKey(modelUrl, maxNumTokens));
}

export function getEngine(
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

// The exact shape of the response Message object isn't fully pinned down in
// the (early preview) public docs, so this extracts text defensively across
// a couple of plausible shapes rather than assuming one.
export function extractText(message: unknown): string {
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
