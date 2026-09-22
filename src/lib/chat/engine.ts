/**
 * Engine lifecycle and the LiteRT-LM wasm runtime behind it: creating engines,
 * keeping them warm, and getting the model onto disk.
 *
 * Worker-side only — everything here runs inside ./worker.ts, and nothing on
 * the main thread may import it. That isn't a bundle-size rule (the heavy
 * imports below are dynamic either way) but a threading one: the library pins
 * itself to whichever thread calls it, via `setSingleThreadedExecution(true)`
 * in `Engine.create()`, so a stray main-thread call would quietly put the
 * model compile and the decode loop back where they were.
 *
 * The conversational API that uses all this lives in ./index.ts.
 */

import type { Engine, EngineSettings } from '@litert-lm/core';
// Keys the runtime marker written below, so a dependency bump misses the old
// marker rather than matching it. ./index.ts reads that marker back and so
// imports the same version the same way — from the package manifest, which the
// `exports` map does expose, rather than from the library itself, whose 20 MB
// of wasm must not be dragged in to answer a question about whether it is
// cached. Not in ./constants.ts either, which `sw.ts` can reach through
// `lib/cache/rules.ts` and which must therefore stay free of this package.
import { version as LITERT_VERSION } from '@litert-lm/core/package.json';
import { hasAsset, markStep } from '#/lib/cache/markers';
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
 * Pulls the model file down ahead of time so the first call to generate()
 * doesn't pay that cost. The bytes land in the service worker's cache and are
 * discarded here — `Engine.create()` re-reads them from there, which is cheap,
 * rather than this holding gigabytes for the session.
 *
 * Deliberately stops short of initializing the engine (the "warm up") — that's
 * a separate, slower step left for the first generate to do on demand, e.g.
 * while generating the greeting.
 */
export async function preloadModel(modelUrl: string): Promise<void> {
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
