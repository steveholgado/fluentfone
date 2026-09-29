import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLAIM,
  PROGRESS_CHANNEL,
  TAKE_OVER,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { MODELS_CACHE } from '#/lib/cache/names';
import { stubCacheStorage, type FakeCache } from '#/test-utils';

const PRECACHE_URLS = [
  '/app',
  '/assets/index-aaa.js',
  '/assets/worker-bbb.js',
  '/assets/styles-ccc.css',
];

// Mutable so the dev case — an empty list, which is what switches the whole
// shell tier off — can be exercised against the same harness. A getter because
// sw.ts reads the list at module scope, so the value has to be live at import.
const precache = vi.hoisted(() => ({ urls: [] as string[] }));

vi.mock('#/sw-precache', () => ({
  BUILD_ID: 'testbuild',
  get PRECACHE_URLS() {
    return precache.urls;
  },
}));

/** Re-imports the worker with a different precache list. */
async function reloadWorker(urls: string[]) {
  precache.urls = urls;
  vi.resetModules();
  handlers.clear();
  await import('#/sw');
}

const SHELL_CACHE = 'shell-testbuild';

type Handler = (event: unknown) => void;

let handlers: Map<string, Handler>;
let buckets: Map<string, FakeCache>;
let skipWaiting: ReturnType<typeof vi.fn>;
let claim: ReturnType<typeof vi.fn>;
let openClients: { id: string; url: string }[];
let registration: { active: unknown };

/** Fires install/activate and waits for whatever it passed to waitUntil. */
async function fire(type: 'install' | 'activate') {
  const waits: Promise<unknown>[] = [];
  handlers.get(type)?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
}

interface FakeRequestInit extends Omit<RequestInit, 'mode'> {
  mode?: string;
}

/** Fires fetch and returns what the worker responded with, if anything. */
async function fetchEvent(url: string, init: FakeRequestInit = {}) {
  const { mode = 'cors', ...rest } = init;
  // The Request constructor rejects `mode: 'navigate'` outright — only the
  // browser may mint one — so it goes on afterwards.
  const request = new Request(url, rest);
  Object.defineProperty(request, 'mode', { value: mode });

  let responded: Response | Promise<Response> | undefined;
  const waits: Promise<unknown>[] = [];

  handlers.get('fetch')?.({
    request,
    respondWith: (r: Response | Promise<Response>) => {
      responded = r;
    },
    waitUntil: (p: Promise<unknown>) => waits.push(p),
  });

  if (responded === undefined) return undefined;

  const response = await responded;
  // The cache write is handed to waitUntil, so it has to be let finish before
  // a test can assert on what landed.
  void Promise.all(waits);
  return response;
}

beforeEach(async () => {
  handlers = new Map();
  skipWaiting = vi.fn().mockResolvedValue(undefined);
  claim = vi.fn().mockResolvedValue(undefined);
  openClients = [];
  registration = { active: null };

  vi.stubGlobal('self', {
    addEventListener: (type: string, handler: Handler) =>
      handlers.set(type, handler),
    skipWaiting,
    clients: { claim, matchAll: vi.fn(async () => openClients) },
    registration,
  });

  buckets = stubCacheStorage();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | Request) => {
      const url = typeof input === 'string' ? input : input.url;
      return new Response(`network:${url}`, { status: 200 });
    }),
  );

  await reloadWorker(PRECACHE_URLS);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('install', () => {
  it('precaches the whole shell into a build-versioned bucket', async () => {
    await fire('install');

    const shell = buckets.get(SHELL_CACHE);
    expect(shell).toBeDefined();
    expect(shell?.addAll).toHaveBeenCalledWith(PRECACHE_URLS);
    expect(shell?.store.size).toBe(PRECACHE_URLS.length);
  });

  it('precaches the worker chunks, which appear in no HTML document', async () => {
    // Workers are spawned by absolute URL, so a precache list built by
    // crawling the documents would boot the shell and then fail the first
    // time the app tried to transcribe or speak.
    await fire('install');

    const shell = buckets.get(SHELL_CACHE);
    expect(
      shell?.store.has(new URL('/assets/worker-bbb.js', location.href).href),
    ).toBe(true);
  });

  it('takes control immediately on a first install', async () => {
    // Otherwise the worker sees none of the downloads on the one visit where
    // all of them happen.
    await fire('install');

    expect(skipWaiting).toHaveBeenCalled();
  });

  it('waits for the next navigation when replacing an existing worker', async () => {
    // A new deploy must not swap the shell out from under a running page.
    registration.active = {};

    await fire('install');

    expect(skipWaiting).not.toHaveBeenCalled();
  });
});

describe('take over', () => {
  /** Posts a message from the tab with id `from`; returns the answer port. */
  async function message(data: unknown, from = 'starting') {
    const port = { postMessage: vi.fn() };
    const waits: Promise<unknown>[] = [];

    handlers.get('message')?.({
      data,
      source: { id: from },
      ports: [port],
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });

    await Promise.all(waits);
    return port;
  }

  beforeEach(() => {
    // An update, waiting behind an existing worker.
    registration.active = {};
  });

  it('takes over when asked by the only tab running the app', async () => {
    openClients = [
      { id: 'starting', url: 'http://localhost:3000/app' },
      // Other pages load nothing from the shell, so they don't hold it back.
      { id: 'home', url: 'http://localhost:3000/' },
    ];

    const port = await message(TAKE_OVER);

    expect(skipWaiting).toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(true);
  });

  it('declines while another tab is running the app', async () => {
    // Switching would move that tab onto this build's shell mid-session.
    openClients = [
      { id: 'starting', url: 'http://localhost:3000/app' },
      { id: 'other', url: 'http://localhost:3000/app?utm=x' },
    ];

    const port = await message(TAKE_OVER);

    expect(skipWaiting).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith(false);
  });

  it('ignores any other message', async () => {
    const port = await message('something-else');

    expect(skipWaiting).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('claims when asked by a page it does not control', async () => {
    // A hard reload loads the page past this worker, which, already active,
    // would never claim it on its own.
    await message(CLAIM);

    expect(claim).toHaveBeenCalled();
    expect(skipWaiting).not.toHaveBeenCalled();
  });
});

describe('activate', () => {
  it('claims open clients, including the web workers', async () => {
    await fire('activate');

    expect(claim).toHaveBeenCalled();
  });

  it('purges shells from previous builds', async () => {
    await caches.open('shell-oldbuild');
    await caches.open(SHELL_CACHE);

    await fire('activate');

    expect(buckets.has('shell-oldbuild')).toBe(false);
    expect(buckets.has(SHELL_CACHE)).toBe(true);
  });

  it('never purges the models bucket', async () => {
    // It holds gigabytes the user explicitly agreed to download, and must
    // survive every deploy.
    await caches.open(MODELS_CACHE);

    await fire('activate');

    expect(buckets.has(MODELS_CACHE)).toBe(true);
  });
});

describe('fetch', () => {
  it('serves a navigation from the shell', async () => {
    await fire('install');
    vi.mocked(fetch).mockClear();

    const response = await fetchEvent('http://localhost:3000/app', {
      mode: 'navigate',
    });

    expect(await response?.text()).toBe('network:/app');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores the query string when matching a document', async () => {
    await fire('install');
    vi.mocked(fetch).mockClear();

    const response = await fetchEvent('http://localhost:3000/app?utm=x', {
      mode: 'navigate',
    });

    expect(await response?.text()).toBe('network:/app');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves every page but /app to the network, the home page included', async () => {
    // Only the app is precached. Other pages aren't cached at all, so there is
    // no document for the worker to answer with — online or off.
    await fire('install');

    for (const path of ['/', '/nope']) {
      const response = await fetchEvent(`http://localhost:3000${path}`, {
        mode: 'navigate',
      });

      expect(response).toBeUndefined();
    }
  });

  it('serves a precached asset from the shell', async () => {
    await fire('install');
    vi.mocked(fetch).mockClear();

    const response = await fetchEvent(
      'http://localhost:3000/assets/worker-bbb.js',
    );

    expect(await response?.text()).toBe('network:/assets/worker-bbb.js');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes through a same-origin asset that is not precached', async () => {
    // The 35 MB of ort-wasm-*.wasm sitting in the same directory belongs to
    // the user-gated model tier, not the shell.
    await fire('install');

    const response = await fetchEvent(
      'http://localhost:3000/assets/ort-wasm-simd-threaded-xyz.wasm',
    );

    expect(response).toBeUndefined();
  });

  it('passes through cross-origin requests it owns no rule for', async () => {
    await fire('install');

    const response = await fetchEvent('https://example.com/analytics.js');

    expect(response).toBeUndefined();
  });

  it('passes through non-GET requests', async () => {
    await fire('install');

    const response = await fetchEvent('http://localhost:3000/app', {
      method: 'POST',
      mode: 'navigate',
    });

    expect(response).toBeUndefined();
  });
});

describe('with no shell to precache (dev)', () => {
  // Vite serves modules on demand and rewrites them on every edit, so the dev
  // worker has to keep its hands off everything same-origin. An empty
  // precache list is what signals that.
  beforeEach(async () => {
    await reloadWorker([]);
  });

  it('opens no shell cache at all', async () => {
    await fire('install');

    expect(buckets.has(SHELL_CACHE)).toBe(false);
  });

  it('takes control immediately, even when replacing a worker', async () => {
    // The usual wait-for-the-next-navigation rule protects a running page from
    // having its shell swapped out. With no shell there is nothing to protect,
    // and waiting would just mean an edit to sw.ts appearing not to take.
    registration.active = {};

    await fire('install');

    expect(skipWaiting).toHaveBeenCalled();
  });

  it('leaves navigations to the dev server', async () => {
    await fire('install');

    const response = await fetchEvent('http://localhost:3000/app', {
      mode: 'navigate',
    });

    expect(response).toBeUndefined();
  });

  it('leaves same-origin module requests to the dev server', async () => {
    // Serving these from a cache is exactly what breaks HMR.
    await fire('install');

    const response = await fetchEvent('http://localhost:3000/src/main.tsx');

    expect(response).toBeUndefined();
  });

  it('still serves the vendored wasm, which is not part of the shell', async () => {
    // Same-origin, but it belongs to the model tier — 30 MB that would
    // otherwise re-download on every reload, since dev serves public/ with no
    // cache headers.
    await fire('install');

    const response = await fetchEvent(
      'http://localhost:3000/vendor/onnx/1.23.2/ort-wasm-simd-threaded.jsep.mjs',
    );

    expect(response).toBeDefined();
  });
});

const MODEL_URL = 'https://huggingface.co/litert-community/model.litertlm';
const VOICE_URL = 'https://huggingface.co/diffusionstudio/piper-voices/v.onnx';

/** Whether `url` ended up in a bucket — false if the bucket never opened. */
function stored(bucket: string, url: string): boolean {
  return buckets.get(bucket)?.store.has(url) ?? false;
}

/** Serves a body of `size` bytes in 1 KB chunks, with a Content-Length. */
function stubDownload(size: number) {
  vi.mocked(fetch).mockImplementation(async () => {
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= size) return controller.close();
          const chunk = Math.min(1024, size - sent);
          sent += chunk;
          controller.enqueue(new Uint8Array(chunk));
        },
      }),
      { status: 200, headers: { 'Content-Length': String(size) } },
    );
  });
}

/** Collects everything the worker broadcasts while `run` is in flight. */
async function captureProgress(run: () => Promise<Response | undefined>) {
  const seen: AssetProgressMessage[] = [];
  const channel = new BroadcastChannel(PROGRESS_CHANNEL);
  channel.onmessage = (event: MessageEvent<AssetProgressMessage>) =>
    seen.push(event.data);

  const response = await run();
  // Counting happens as the body is read, so it has to be drained.
  await response?.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 0));

  channel.close();
  return seen;
}

describe('models and runtimes', () => {
  it('stores a model in the models bucket, never the shell', async () => {
    // The shell is purged on every deploy. Three gigabytes must not be.
    stubDownload(4096);

    const response = await fetchEvent(MODEL_URL);
    await response?.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored(MODELS_CACHE, MODEL_URL)).toBe(true);
    expect(stored(SHELL_CACHE, MODEL_URL)).toBe(false);
  });

  it('serves a second request from cache without touching the network', async () => {
    stubDownload(4096);
    await (await fetchEvent(MODEL_URL))?.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(fetch).mockClear();

    const response = await fetchEvent(MODEL_URL);

    expect(response).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports bytes as they stream past', async () => {
    stubDownload(1_048_576);

    const seen = await captureProgress(() => fetchEvent(MODEL_URL));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({
      step: 'chat',
      url: MODEL_URL,
      loaded: 1_048_576,
      total: 1_048_576,
    });
  });

  it('serves a cache hit untouched, without counting it', async () => {
    // Every warm-up reads gigabytes back through here, and re-streaming them
    // through a counter is paid on every load for a bar that isn't showing.
    stubDownload(1_048_576);
    await (await fetchEvent(MODEL_URL))?.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(fetch).mockClear();

    const seen = await captureProgress(() => fetchEvent(MODEL_URL));

    expect(fetch).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('reports byte counts that only ever climb', async () => {
    // The bar never moves backwards, so a figure that dipped would pin it.
    stubDownload(1_048_576);

    const seen = await captureProgress(() => fetchEvent(MODEL_URL));

    const loaded = seen.map((m) => m.loaded);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
  });

  it('counts the voice without storing it', async () => {
    // piper-tts-web keeps voices in OPFS and cannot be pointed elsewhere, so
    // caching them here would pay for the voice twice.
    stubDownload(4096);

    const seen = await captureProgress(() => fetchEvent(VOICE_URL));

    expect(seen.at(-1)?.step).toBe('text-to-speech');
    expect(stored(MODELS_CACHE, VOICE_URL)).toBe(false);
  });

  it('does not store a failed download', async () => {
    // A 404 body cached under the model URL would look like a hit forever.
    vi.mocked(fetch).mockResolvedValue(
      new Response('nope', { status: 404, headers: { 'Content-Length': '4' } }),
    );

    const response = await fetchEvent(MODEL_URL);

    expect(response?.status).toBe(404);
    expect(stored(MODELS_CACHE, MODEL_URL)).toBe(false);
  });

  it('records a failed cache write against the step', async () => {
    // Over quota, most likely. The step still resolves and writes its marker,
    // so without this record the next visit would believe the model is on
    // disk and quietly download it again.
    stubDownload(4096);
    const models = await caches.open(MODELS_CACHE);
    vi.mocked(models.put).mockRejectedValueOnce(
      new DOMException('Quota exceeded', 'QuotaExceededError'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await fetchEvent(MODEL_URL);
    await response?.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The caller still gets the bytes; only storing them failed.
    expect(response?.status).toBe(200);
    expect(stored(MODELS_CACHE, MODEL_URL)).toBe(false);
    expect(stored(MODELS_CACHE, 'https://write-failed.invalid/chat')).toBe(
      true,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records nothing when the cache write succeeds', async () => {
    stubDownload(4096);

    await (await fetchEvent(MODEL_URL))?.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored(MODELS_CACHE, 'https://write-failed.invalid/chat')).toBe(
      false,
    );
  });

  it('caches a model even with no shell, as it does in dev', async () => {
    // The whole reason the dev worker exists: 3 GB re-downloaded on every
    // reload is not a workable dev loop.
    await reloadWorker([]);
    stubDownload(4096);

    const seen = await captureProgress(() => fetchEvent(MODEL_URL));

    expect(stored(MODELS_CACHE, MODEL_URL)).toBe(true);
    expect(seen.at(-1)?.step).toBe('chat');
  });

  it('recognises any of the litert wasm build variants', async () => {
    // The library picks between four by feature detection. Matching on the
    // package path rather than a predicted filename is what lets us stop
    // reproducing that choice.
    stubDownload(1024);

    for (const file of [
      'litertlm_wasm_internal.wasm',
      'litertlm_wasm_compat_asyncify_internal.wasm',
    ]) {
      const url = `https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/wasm/${file}`;
      const seen = await captureProgress(() => fetchEvent(url));
      expect(seen.at(-1)?.step).toBe('chat-runtime');
    }
  });
});
