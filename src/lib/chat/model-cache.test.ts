import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearModelCache,
  fetchModelAsBlob,
  hasCachedModel,
} from '#/lib/chat/model-cache';

const MODEL_URL = 'https://example.com/model.litertlm';

function makeCache() {
  const store = new Map<string, Response>();

  return {
    store,
    match: vi.fn((req: string | Request) => {
      const url = typeof req === 'string' ? req : req.url;
      return Promise.resolve(store.get(url));
    }),
    put: vi.fn((req: string | Request, res: Response) => {
      const url = typeof req === 'string' ? req : req.url;
      store.set(url, res);
      return Promise.resolve();
    }),
    keys: vi.fn(() =>
      Promise.resolve(Array.from(store.keys()).map((url) => new Request(url))),
    ),
    delete: vi.fn((req: string | Request) => {
      const url = typeof req === 'string' ? req : req.url;
      return Promise.resolve(store.delete(url));
    }),
  };
}

function stubCaches(cache: ReturnType<typeof makeCache>) {
  vi.stubGlobal('caches', {
    open: vi.fn().mockResolvedValue(cache),
    delete: vi.fn().mockResolvedValue(true),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchModelAsBlob', () => {
  it('downloads and caches the model when nothing is cached yet', async () => {
    const cache = makeCache();
    stubCaches(cache);

    const body = new Blob(['model bytes']);
    const response = new Response(body, {
      headers: { 'Content-Length': String(body.size) },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const result = await fetchModelAsBlob(MODEL_URL);

    expect(result).toBeInstanceOf(Blob);
    expect(cache.put).toHaveBeenCalled();
  });

  it('returns the cached blob without fetching when already cached', async () => {
    const cache = makeCache();
    cache.store.set(MODEL_URL, new Response('cached bytes'));
    stubCaches(cache);

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await fetchModelAsBlob(MODEL_URL);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await result.text()).toBe('cached bytes');
  });

  it('reports progress while streaming the download', async () => {
    const cache = makeCache();
    stubCaches(cache);

    const chunk = new Uint8Array([1, 2, 3]);
    const response = new Response(chunk, {
      headers: { 'Content-Length': String(chunk.byteLength) },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    const onProgress = vi.fn();
    await fetchModelAsBlob(MODEL_URL, onProgress);

    expect(onProgress).toHaveBeenCalled();
    const lastCall = onProgress.mock.calls.at(-1)?.[0];
    expect(lastCall.progress).toBe(1);
  });

  it('evicts other cached models before downloading a new one', async () => {
    const cache = makeCache();
    cache.store.set('https://example.com/other.litertlm', new Response());
    stubCaches(cache);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new Blob(['x']))),
    );

    await fetchModelAsBlob(MODEL_URL);

    expect(cache.delete).toHaveBeenCalled();
    expect(cache.store.has('https://example.com/other.litertlm')).toBe(false);
  });

  it('throws when the download response is not ok', async () => {
    const cache = makeCache();
    stubCaches(cache);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    await expect(fetchModelAsBlob(MODEL_URL)).rejects.toThrow(
      /Failed to download model/,
    );
  });

  it('falls back to a plain fetch when the Cache Storage API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('no cache api')),
    );

    const result = await fetchModelAsBlob(MODEL_URL);

    expect(await result.text()).toBe('no cache api');
  });
});

describe('hasCachedModel', () => {
  it('returns false when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(hasCachedModel(MODEL_URL)).resolves.toBe(false);
  });

  it('returns true only when the model URL is present in the cache', async () => {
    const cache = makeCache();
    cache.store.set(MODEL_URL, new Response());
    stubCaches(cache);

    await expect(hasCachedModel(MODEL_URL)).resolves.toBe(true);
    await expect(hasCachedModel('https://example.com/other')).resolves.toBe(
      false,
    );
  });
});

describe('clearModelCache', () => {
  it('deletes the model cache bucket', async () => {
    const deleteSpy = vi.fn().mockResolvedValue(true);

    vi.stubGlobal('caches', { delete: deleteSpy, open: vi.fn() });

    await clearModelCache();

    expect(deleteSpy).toHaveBeenCalled();
  });

  it('is a no-op when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(clearModelCache()).resolves.toBeUndefined();
  });
});
