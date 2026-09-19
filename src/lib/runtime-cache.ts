/**
 * Prefetching for the wasm *runtimes* our model libraries load at run time —
 * as opposed to the model weights themselves, which each library persists in
 * its own storage (Cache Storage, OPFS) and can be probed for directly.
 *
 * Both LiteRT-LM and Transformers.js resolve their wasm by URL at run time
 * rather than through an import a bundler could follow, and neither reports
 * progress while fetching it. Left alone that means tens of megabytes landing
 * silently, in LiteRT's case during the conversation itself. So we fetch the
 * same URLs ourselves first, with progress, purely to warm the browser's HTTP
 * cache — the library's own fetch then resolves from disk.
 *
 * Because that leaves no artifact we can look for later, a successful warm
 * also writes a small receipt into Cache Storage, which is what `isCached()`
 * checks. See `hasWarmRuntime` for the one case where we can do better.
 */

import type { LoadProgress, ProgressCallback } from './progress';

const RUNTIME_CACHE_NAME = 'runtime-cache-v1';

/**
 * Receipts are keyed by an opaque, versioned string (e.g. `litert:0.14.0`)
 * rather than by the runtime's URL, so that a dependency bump invalidates the
 * old receipt instead of silently matching it. Cache Storage keys have to be
 * requests, so the key is mapped onto a URL that is never actually fetched.
 */
function receiptUrl(markerKey: string): string {
  return `https://runtime-cache.invalid/${encodeURIComponent(markerKey)}`;
}

/**
 * Downloads `urls` so they land in the HTTP cache, reporting one combined
 * progress figure across all of them, then records a receipt under
 * `markerKey`.
 *
 * Runs in two phases so the reported total never moves. Every request is sent
 * first and only its headers awaited, which settles the full byte count; the
 * bodies are then streamed. Summing totals as each file arrived instead would
 * let the denominator grow mid-download, and a growing denominator either
 * makes the bar jump backwards or — since the bar in usePreload only moves
 * forward — strands it at a peak it reached early.
 */
export async function warmRuntime(
  urls: string[],
  markerKey: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const responses = await Promise.all(urls.map((url) => request(url)));

  const loadedPerUrl = new Array<number>(responses.length).fill(0);
  const total = responses.reduce((sum, r) => sum + r.total, 0);

  const report = () => {
    if (!onProgress) return;

    const loaded = loadedPerUrl.reduce((sum, n) => sum + n, 0);
    const progress: LoadProgress = {
      loaded,
      // A server that sent no Content-Length leaves the total short, so
      // report it as unknown rather than as a number the bar would overrun.
      total: total || undefined,
      progress: total ? Math.min(loaded / total, 1) : undefined,
    };
    onProgress(progress);
  };

  await Promise.all(
    responses.map((response, i) =>
      drain(response.body, (loaded) => {
        loadedPerUrl[i] = loaded;
        report();
      }),
    ),
  );

  await writeReceipt(markerKey);
}

/**
 * Whether the runtime behind `markerKey` has been downloaded before.
 *
 * This is a receipt, not a measurement: it says "we fetched this once", not
 * "the bytes are still on disk". The HTTP cache is where they actually live,
 * and it can't be queried — `fetch(url, { cache: 'only-if-cached' })` is
 * restricted to same-origin mode, and even there Chrome logs an ERR_CACHE_MISS
 * to the console and the network panel on every miss, which would mean a
 * fistful of red on each cold load for an answer that's only slightly better.
 *
 * So a receipt can outlive what it stands for, if the HTTP cache is evicted
 * while Cache Storage survives. Callers must stay responsive to a re-download
 * rather than assume one can't happen — see the stage reporting in
 * useConversation, which exists for exactly that case.
 */
export async function hasWarmRuntime(markerKey: string): Promise<boolean> {
  return hasReceipt(markerKey);
}

/** Removes every runtime receipt, so the next check reports "not warmed". */
export async function clearRuntimeReceipts(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await caches.delete(RUNTIME_CACHE_NAME);
}

/** Sends the request and reads its declared size, without consuming the body. */
async function request(
  url: string,
): Promise<{ body: Response; total: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download runtime (${response.status}): ${url}`);
  }

  return {
    body: response,
    total: Number(response.headers.get('Content-Length')) || 0,
  };
}

/** Reads a response to completion, reporting bytes read as it goes. */
async function drain(
  response: Response,
  onLoaded: (loaded: number) => void,
): Promise<void> {
  if (!response.body) {
    // No stream to measure — still read it through so it gets cached.
    const buffer = await response.arrayBuffer();
    onLoaded(buffer.byteLength);
    return;
  }

  const reader = response.body.getReader();
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      onLoaded(loaded);
      return;
    }
    loaded += value.byteLength;
    onLoaded(loaded);
  }
}

async function writeReceipt(markerKey: string): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(receiptUrl(markerKey), new Response('1'));
  } catch (err) {
    // A missing receipt only costs us a redundant warm next time.
    console.warn('Runtime receipt write failed (continuing):', err);
  }
}

async function hasReceipt(markerKey: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(RUNTIME_CACHE_NAME);
  return (await cache.match(receiptUrl(markerKey))) !== undefined;
}
