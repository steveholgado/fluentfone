import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRuntimeReceipts,
  hasWarmRuntime,
  warmRuntime,
} from '#/lib/runtime-cache';

/** A Response whose body streams `chunks` and reports a Content-Length. */
function streamed(chunks: number[][], contentLength?: number) {
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

/** Minimal Cache Storage stand-in, keyed by request URL. */
function stubCaches() {
  const store = new Map<string, Map<string, Response>>();

  const api = {
    open: async (name: string) => {
      let cache = store.get(name);
      if (!cache) {
        cache = new Map();
        store.set(name, cache);
      }
      const bucket = cache;
      return {
        put: async (url: string, response: Response) => {
          bucket.set(url, response);
        },
        match: async (url: string) => bucket.get(url),
      };
    },
    delete: async (name: string) => store.delete(name),
  };

  vi.stubGlobal('caches', api);
  return store;
}

beforeEach(() => {
  stubCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('warmRuntime', () => {
  it('fetches every url so the bytes land in the HTTP cache', async () => {
    const fetchMock = vi.fn(async (_url: string) => streamed([[1, 2, 3]]));
    vi.stubGlobal('fetch', fetchMock);

    await warmRuntime(['/a.wasm', '/b.mjs'], 'key');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('/a.wasm');
    expect(fetchMock).toHaveBeenCalledWith('/b.mjs');
  });

  it('reports one total summed across every file, not one per file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([[1, 2, 3, 4, 5]])),
    );

    const onProgress = vi.fn();
    await warmRuntime(['/a.wasm', '/b.mjs'], 'key', onProgress);

    // Whatever order the chunks arrive in, the last report covers both files
    // in full — so the bar ends at 100% rather than at one file's worth.
    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 10,
      total: 10,
      progress: 1,
    });
  });

  it('never reports a total that grows mid-download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamed([
          [1, 2],
          [3, 4],
        ]),
      ),
    );

    const reports: { loaded: number; total?: number }[] = [];
    await warmRuntime(['/a.wasm', '/b.mjs'], 'key', (p) =>
      reports.push({ loaded: p.loaded, total: p.total }),
    );

    // A denominator that grows mid-download either makes the bar jump
    // backwards or — since usePreload's bar only moves forward — strands it
    // at a peak reached early. Both sizes are known before any byte is
    // reported, so the total is 8 from the first report to the last.
    expect(reports.every((r) => r.total === 8)).toBe(true);
    expect(reports.at(-1)).toEqual({ loaded: 8, total: 8 });
  });

  it('never reports a percentage above 100', async () => {
    // A Content-Length that undercounts the body it precedes would otherwise
    // push the bar past full.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([[1, 2, 3, 4]], 2)),
    );

    const percentages: (number | undefined)[] = [];
    await warmRuntime(['/a.wasm'], 'key', (p) => percentages.push(p.progress));

    expect(Math.max(...(percentages as number[]))).toBe(1);
  });

  it('reports an unknown total when there is no Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const onProgress = vi.fn();
    await warmRuntime(['/a.wasm'], 'key', onProgress);

    // Better an honest "unknown" — which formatProgress renders as megabytes
    // and the bar treats as 0 until the step's DONE lands — than a total
    // invented from the bytes seen so far, which would read as 100% from the
    // very first chunk.
    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 4,
      total: undefined,
      progress: undefined,
    });
  });

  it('writes a receipt once every file has landed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([[1]])),
    );

    await expect(hasWarmRuntime('key')).resolves.toBe(false);
    await warmRuntime(['/a.wasm'], 'key');
    await expect(hasWarmRuntime('key')).resolves.toBe(true);
  });

  it('throws and writes no receipt when a file fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(warmRuntime(['/a.wasm'], 'key')).rejects.toThrow(
      /Failed to download runtime/,
    );
    // A receipt here would claim a runtime is on disk when it isn't, and the
    // preload screen would be skipped on that basis.
    await expect(hasWarmRuntime('key')).resolves.toBe(false);
  });

  it('keys receipts separately, so one runtime does not vouch for another', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([[1]])),
    );

    await warmRuntime(['/a.wasm'], 'litert:1.0.0');

    await expect(hasWarmRuntime('litert:1.0.0')).resolves.toBe(true);
    await expect(hasWarmRuntime('litert:2.0.0')).resolves.toBe(false);
  });
});

describe('hasWarmRuntime', () => {
  it('never touches the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await hasWarmRuntime('key');

    // It runs during the check stage, before the user has agreed to any
    // download. An earlier version probed the HTTP cache with
    // `only-if-cached`; Chrome logs an ERR_CACHE_MISS to the console and the
    // network panel on every miss, so the check painted the console red on
    // each cold load.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is false, not an error, when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(hasWarmRuntime('key')).resolves.toBe(false);
  });
});

describe('clearRuntimeReceipts', () => {
  it('drops the receipts so the next check reports not warmed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamed([[1]])),
    );

    await warmRuntime(['/a.wasm'], 'key');
    await clearRuntimeReceipts();

    await expect(hasWarmRuntime('key')).resolves.toBe(false);
  });
});
