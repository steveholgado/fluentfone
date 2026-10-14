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

import type { Engine, EngineSettings, GpuArtisanConfig } from '@litert-lm/core';

import { hasAsset } from '#/lib/cache/markers';
import { pullThrough } from '#/lib/cache/pull-through';

import { MAX_TOP_K, engineKey } from './constants';
import type { GenerateStage } from './types';

/**
 * The WebGPU backend's (GPU_ARTISAN's) default config, as @litert-lm/core
 * 0.17.1 creates it — read back from a live engine. Restated in full because
 * the library replaces the whole config when given one, rather than merging.
 *
 * `max_top_k` is the reason for passing it at all. A conversation whose
 * sampler asks for a larger top-K than the engine was created with fails
 * outright ("Top-K value 40 must be <= 1"), and the library's default has
 * moved before — it was 1, leaving decoding greedy, until it became the 64
 * that MAX_TOP_K happens to match now. Passing it keeps that limit ours.
 * Re-check these on a dependency bump.
 *
 * `use_autosized_ringbuffers` sizes local attention's ring buffers to fit
 * rather than at full size, trading instant rewinding for memory. Off, as the
 * default has it; nothing here rewinds, so it is a candidate to switch on if
 * the context window needs to grow.
 */
const GPU_ARTISAN_CONFIG: GpuArtisanConfig = {
  num_output_candidates: 1,
  wait_for_weight_uploads: false,
  num_decode_steps_per_sync: 1,
  sequence_batch_size: 0,
  supported_lora_ranks: [],
  max_top_k: MAX_TOP_K,
  enable_decode_logits: false,
  enable_external_embeddings: false,
  use_submodel: false,
  use_autosized_ringbuffers: false,
};

/**
 * The LiteRT-LM web SDK (early preview) doesn't persist a downloaded model
 * across page loads, so the file is fetched here and handed over.
 *
 * As a stream, not a Blob. GPU_ARTISAN reads the model in slices straight into
 * the wasm heap, so the engine starts on the first bytes rather than after the
 * last. A Blob would also outlive the load: the engine keeps whatever it was
 * given in its `settings` for its whole life, and a spent stream holds nothing.
 * Only GPU_ARTISAN streams — every other backend gathers the stream whole and
 * copies it again, which is worse than a Blob.
 *
 * Handed over as the response gave it. The stream used to pass through a
 * TransformStream whose flush marked the start of the compile, but the engine
 * doesn't read the whole file before Engine.create() resolves: the last of it
 * is read during the first generate, so that signal came after 'generating'.
 *
 * Nothing is memoized. The service worker holds the bytes, so a second fetch
 * is a cache read rather than a download.
 */
async function fetchModel(
  modelUrl: string,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(modelUrl);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download model (${response.status}): ${modelUrl}`,
    );
  }
  return response.body;
}

// The engine (and its loaded model weights) is expensive to create, so we
// cache one instance per distinct modelUrl/maxNumTokens combination and
// reuse it across calls to generateMessage() for the rest of the page load.
// Nothing deletes one: ending a call drops its conversation, not the engine.
const enginePromises = new Map<string, Promise<Engine>>();

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

      const [modelStream, { Backend, Engine: LiteRTEngine }] =
        await Promise.all([fetchModel(modelUrl), import('@litert-lm/core')]);
      const settings: EngineSettings = {
        model: modelStream,
        // Named rather than left to the library's default, since the config
        // below only applies to this backend — and because it is the one
        // backend that streams the model in (see fetchModel).
        backend: Backend.GPU_ARTISAN,
        mainExecutorSettings: {
          maxNumTokens,
          backendConfig: GPU_ARTISAN_CONFIG,
        },
      };
      // Engine.create() loads the wasm runtime (already on disk if preload
      // ran), sets up the WebGPU device, reads the model in and compiles it,
      // none of it reported by the SDK, so all of it is one stage: 'loading',
      // or 'downloading' above.
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
  if (await hasAsset(modelUrl)) return;

  // Drained, not buffered: a single contiguous ~3 GB allocation fails often
  // enough that the step would reject after a successful download.
  await pullThrough([modelUrl], 'chat model');
}
