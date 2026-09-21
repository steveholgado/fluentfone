/**
 * Shared stubs for the browser storage APIs jsdom doesn't implement.
 *
 * jsdom provides no Cache Storage at all, so every test that touches caching
 * has had to hand-roll a stand-in. These started as file-local helpers in
 * model-cache.test.ts and runtime-cache.test.ts; they live here now because
 * the service worker needs the same shapes and three copies is two too many.
 */

import { vi } from 'vitest';

/** Resolves the way the real Cache does — relative to the document. */
function normalize(request: string | Request, ignoreSearch = false): string {
  const raw = typeof request === 'string' ? request : request.url;
  const url = new URL(raw, location.href);
  if (ignoreSearch) url.search = '';
  return url.href;
}

export interface FakeCache {
  /** Keyed by absolute URL, for direct assertions. */
  store: Map<string, Response>;
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  addAll: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

/**
 * One cache bucket. `addAll` goes through the global `fetch` like the real
 * thing, so tests can assert on what a precache actually requested.
 */
export function makeCache(): FakeCache {
  const store = new Map<string, Response>();

  return {
    store,
    // Cloned on the way out, as the real Cache does: a hit hands back a fresh
    // body every time, and callers that stream it must not disturb the stored
    // copy for the next reader.
    match: vi.fn(
      (request: string | Request, options?: { ignoreSearch?: boolean }) =>
        Promise.resolve(
          store.get(normalize(request, options?.ignoreSearch))?.clone(),
        ),
    ),
    put: vi.fn((request: string | Request, response: Response) => {
      store.set(normalize(request), response);
      return Promise.resolve();
    }),
    addAll: vi.fn(async (urls: string[]) => {
      for (const url of urls) {
        store.set(normalize(url), await fetch(url));
      }
    }),
    keys: vi.fn(() =>
      Promise.resolve(Array.from(store.keys()).map((url) => new Request(url))),
    ),
    delete: vi.fn((request: string | Request) =>
      Promise.resolve(store.delete(normalize(request))),
    ),
  };
}

/**
 * The whole of Cache Storage, creating buckets on demand. Returns the map of
 * bucket name to cache so tests can inspect what ended up where — which bucket
 * a thing lands in is the point of most of these tests.
 */
export function stubCacheStorage(): Map<string, FakeCache> {
  const buckets = new Map<string, FakeCache>();

  vi.stubGlobal('caches', {
    open: vi.fn((name: string) => {
      let cache = buckets.get(name);
      if (!cache) {
        cache = makeCache();
        buckets.set(name, cache);
      }
      return Promise.resolve(cache);
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(buckets.keys()))),
    delete: vi.fn((name: string) => Promise.resolve(buckets.delete(name))),
    has: vi.fn((name: string) => Promise.resolve(buckets.has(name))),
  });

  return buckets;
}

/** A Response whose body streams `chunks` and reports a Content-Length. */
export function streamed(chunks: number[][], contentLength?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });

  const total = contentLength ?? chunks.reduce((n, c) => n + c.length, 0);

  return new Response(body, {
    status: 200,
    headers: { 'Content-Length': String(total) },
  });
}
