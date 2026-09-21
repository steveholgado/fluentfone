/**
 * The service worker. Owns every cache the app has, so that "is this on disk?"
 * is one question asked one way instead of five.
 *
 * It serves two tiers that have nothing to do with each other:
 *
 * - The app shell is precached on install, so the app boots with no network.
 *   It is versioned by build and replaced wholesale on each deploy.
 * - Runtimes and model weights are cached the first time they are fetched,
 *   during the preload the user has explicitly agreed to. Three gigabytes is
 *   not something to pull down before being asked, so none of it is precached.
 *
 * Tier 2 is also where byte counting happens. The libraries fetch their own
 * wasm and report nothing, so rather than predicting their URLs and fetching
 * them first ourselves, the bytes are counted here as they pass through and
 * broadcast to whoever is listening.
 *
 * Two things about how this is written are load-bearing:
 *
 * 1. Every global-scope access goes through `sw.` rather than being called
 *    bare. Vitest's jsdom environment sets `self === globalThis`, so a bare
 *    `addEventListener` would register on the window and the test's stub would
 *    never see it.
 * 2. The scope is typed by hand below rather than via
 *    `/// <reference lib="webworker" />`. tsconfig includes every .ts file in
 *    one program with the DOM lib, and pulling in WebWorker alongside it
 *    produces a wall of duplicate-identifier errors. This mirrors the
 *    `self as unknown as Worker` cast the two Web Workers already use.
 */

import { BUILD_ID, PRECACHE_URLS } from './sw-precache';
import {
  MODELS_CACHE,
  PROGRESS_CHANNEL,
  ruleFor,
  SHELL_CACHE_PREFIX,
  shellCacheName,
  type AssetProgressMessage,
  type AssetRule,
} from './lib/assets';

interface SwExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface ServiceWorkerScope {
  addEventListener(
    type: 'install' | 'activate',
    handler: (event: SwExtendableEvent) => void,
  ): void;
  addEventListener(type: 'fetch', handler: (event: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  registration: { active: unknown };
}

const sw = self as unknown as ServiceWorkerScope;

const SHELL_CACHE = shellCacheName(BUILD_ID);

/** Path lookup for the fetch handler; PRECACHE_URLS are already paths. */
const precached = new Set(PRECACHE_URLS);

/**
 * Whether there is an app shell to precache and serve.
 *
 * False in dev, where the list is empty: Vite compiles modules on demand and
 * rewrites them on every edit, so caching them would serve stale code and
 * break HMR. The model tier is untouched by this, which is the whole point —
 * dev gets the multi-gigabyte caching and the progress reporting, and none of
 * the staleness that made a dev worker a bad idea in the first place.
 */
const SHELL_ENABLED = PRECACHE_URLS.length > 0;

sw.addEventListener('install', (event) => {
  event.waitUntil(install());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Assets first, and without an origin check: most of them are cross-origin,
  // coming from the CDNs the libraries are pinned to.
  const rule = ruleFor(url);
  if (rule) {
    event.respondWith(serveAsset(event, request, rule));
    return;
  }

  if (url.origin !== location.origin) return;

  // Everything below serves the shell. In dev that is the dev server's job,
  // including the module graph and its rewrites, so leave it alone.
  if (!SHELL_ENABLED) return;

  if (request.mode === 'navigate') {
    event.respondWith(serveNavigation(request));
    return;
  }

  if (precached.has(url.pathname)) {
    event.respondWith(serveShellAsset(request));
  }
});

async function install(): Promise<void> {
  if (SHELL_ENABLED) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(PRECACHE_URLS);
  }

  // Only on a first-ever install. Without this the worker doesn't control the
  // page that registered it until the next navigation — which is precisely the
  // visit where the user downloads everything, so it would observe none of it.
  //
  // Deliberately NOT done on an update: a new deploy should take over on the
  // next navigation rather than swapping the shell under a running page. That
  // reasoning is about the shell, so it doesn't apply in dev — there, an edit
  // to this file should take effect on the reload that fetched it.
  if (!SHELL_ENABLED || !sw.registration.active) {
    await sw.skipWaiting();
  }
}

async function activate(): Promise<void> {
  await purgeOldShells();
  // Dedicated workers are clients too, so this picks up the speech-to-text and
  // text-to-speech workers along with the page.
  await sw.clients.claim();
}

/**
 * Drops every previous build's shell. Matches on the `shell-` prefix, so the
 * models bucket is never a candidate however this is called.
 */
async function purgeOldShells(): Promise<void> {
  const names = await caches.keys();

  await Promise.all(
    names
      .filter((name) => name.startsWith(SHELL_CACHE_PREFIX))
      .filter((name) => name !== SHELL_CACHE)
      .map((name) => caches.delete(name)),
  );
}

/**
 * Documents are served from the shell so the app boots offline. `ignoreSearch`
 * because a query string doesn't change which prerendered document applies,
 * and `ignoreVary` because the precached responses were stored against a
 * fetch, not against this navigation's headers.
 */
async function serveNavigation(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);

  const cached = await cache.match(request, {
    ignoreSearch: true,
    ignoreVary: true,
  });
  if (cached) return cached;

  try {
    return await fetch(request);
  } catch {
    // Offline and no exact match — hand back the root document and let the
    // client router resolve the path (including to its not-found route).
    const fallback = await cache.match('/', { ignoreVary: true });
    if (fallback) return fallback;
    throw new Error('Offline, and no cached document to fall back to.');
  }
}

/** Hashed assets are immutable, so a hit is always correct. */
async function serveShellAsset(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);

  const cached = await cache.match(request, { ignoreVary: true });
  if (cached) return cached;

  return fetch(request);
}

/**
 * A runtime or model file. Cache-first where the rule says we own the bytes,
 * and counted on the way past either way — including for the voice, whose
 * bytes belong to OPFS but whose progress the bar still wants.
 */
async function serveAsset(
  event: SwFetchEvent,
  request: Request,
  rule: AssetRule,
): Promise<Response> {
  const cache = rule.cache ? await caches.open(MODELS_CACHE) : null;

  if (cache) {
    const cached = await cache.match(request, { ignoreVary: true });
    // Counted, even though no bytes crossed the network. Reading a model back
    // off disk is not instant either, and a step that reports nothing at all
    // doesn't leave the bar at zero — it leaves it showing the previous step's
    // final frame, which is a full bar reading "Finishing up".
    if (cached) return count(cached, rule, request.url, contentLength(cached));
  }

  const response = await fetch(request);

  // A range response or an error is not something to store or measure, and
  // cache.put would reject on it anyway.
  if (!response.ok || response.status !== 200 || !response.body) {
    return response;
  }

  const total = contentLength(response);

  // Keyed by the request, not `response.url` — huggingface.co 302-redirects
  // to its LFS CDN, and the redirected URL is not what anything asks for.
  if (!cache) {
    return count(response, rule, request.url, total);
  }

  // One body, two consumers: the caller gets a counted stream, the cache gets
  // the raw bytes. waitUntil keeps the worker alive for the write even if the
  // caller abandons its branch.
  const [forCaller, forCache] = response.body.tee();

  event.waitUntil(
    // Logged rather than swallowed. A rejection here (quota, most likely, on
    // a file this size) leaves the bytes unstored while the step still
    // succeeds and writes its marker — so the next visit believes the model is
    // on disk and quietly downloads it again.
    cache
      .put(request, new Response(forCache, responseInit(response)))
      .catch((err) =>
        console.warn('Asset cache write failed:', request.url, err),
      ),
  );

  return count(
    new Response(forCaller, responseInit(response)),
    rule,
    request.url,
    total,
  );
}

/** Null where the response declared no length, which the bar treats as unknown. */
function contentLength(response: Response): number | null {
  return Number(response.headers.get('Content-Length')) || null;
}

function responseInit(response: Response): ResponseInit {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
}

/** How many bytes must land before another progress message is worth sending. */
const PROGRESS_INTERVAL_BYTES = 262_144;

/**
 * Re-streams a response, broadcasting how much of it has arrived.
 *
 * Throttled by volume rather than time: a 3 GB model would otherwise post tens
 * of thousands of messages, and the bar cannot render a quarter of a percent.
 */
function count(
  response: Response,
  rule: AssetRule,
  url: string,
  total: number | null,
): Response {
  if (!response.body) return response;

  const channel = new BroadcastChannel(PROGRESS_CHANNEL);

  let loaded = 0;
  let posted = 0;

  const post = () => {
    posted = loaded;
    channel.postMessage({
      step: rule.step,
      url,
      loaded,
      total,
    } satisfies AssetProgressMessage);
  };

  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      if (loaded - posted >= PROGRESS_INTERVAL_BYTES) post();
      controller.enqueue(chunk);
    },
    flush() {
      post();
      channel.close();
    },
  });

  return new Response(response.body.pipeThrough(meter), responseInit(response));
}
