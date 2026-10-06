/**
 * The service worker. Owns every cache the app has, so that "is this on disk?"
 * is one question asked one way instead of five.
 *
 * It serves two tiers that have nothing to do with each other:
 *
 * - The app shell — the /app document and what it loads, nothing from any
 *   other page — is precached on install, so the app boots with no network.
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
// The leaves rather than a barrel: `lib/cache` deliberately has none, so that
// what the service worker bundle pulls in is visible here at the call site.
import {
  CLAIM,
  PROGRESS_CHANNEL,
  TAKE_OVER,
  type AssetProgressMessage,
} from './lib/cache/channel';
import {
  MODELS_CACHE,
  SHELL_CACHE_PREFIX,
  shellCacheName,
} from './lib/cache/names';
import { markWriteFailed } from './lib/cache/markers';
import { ruleFor, type AssetRule } from './lib/cache/rules';

interface SwExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface SwFetchEvent extends SwExtendableEvent {
  request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface SwMessageEvent extends SwExtendableEvent {
  data: unknown;
  source: { id: string } | null;
  ports: readonly MessagePort[];
}

interface SwClient {
  id: string;
  url: string;
}

interface ServiceWorkerScope {
  addEventListener(
    type: 'install' | 'activate',
    handler: (event: SwExtendableEvent) => void,
  ): void;
  addEventListener(type: 'fetch', handler: (event: SwFetchEvent) => void): void;
  addEventListener(
    type: 'message',
    handler: (event: SwMessageEvent) => void,
  ): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<SwClient[]>;
  };
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

sw.addEventListener('message', (event) => {
  if (event.data === TAKE_OVER) event.waitUntil(takeOver(event));
  // A page that loaded past this worker — a hard reload — asking to be
  // claimed (see `resolveController` in lib/sw-client.ts). Nothing is swapped
  // under it: it came from the network, and any of its chunks that aren't in
  // this build's precache still go to the network.
  else if (event.data === CLAIM) event.waitUntil(sw.clients.claim());
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

  // Only /app and what it loads are precached. Every other page — the home
  // page included — is the network's, online or not.
  if (precached.has(url.pathname)) {
    event.respondWith(serveShell(request));
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
  // Deliberately NOT done on an update: that would swap the shell under a
  // running page. An update waits until a starting page asks it to take over
  // (see `takeOver`). That reasoning is about the shell, so it doesn't apply in
  // dev — there, an edit to this file should take effect on the reload that
  // fetched it.
  if (!SHELL_ENABLED || !sw.registration.active) {
    await sw.skipWaiting();
  }
}

/**
 * A page starting up asks a waiting update to take over, then reloads into it
 * (see `applyUpdate` in `lib/sw-client.ts`). Left alone, a waiting worker
 * activates only once every tab running the old one has closed — a refresh
 * isn't enough.
 *
 * It takes over only if no other tab is running the app. Switching would move
 * that tab onto this build's shell mid-session, where the previous build's
 * chunks it asks for next are no longer cached and may no longer be deployed.
 * Tabs on other pages don't count: nothing they load comes from the shell.
 */
async function takeOver(event: SwMessageEvent): Promise<void> {
  const clients = await sw.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  const othersRunningApp = clients.filter(
    (client) =>
      client.id !== event.source?.id &&
      precached.has(new URL(client.url).pathname),
  );

  const accepted = othersRunningApp.length === 0;
  if (accepted) await sw.skipWaiting();

  event.ports[0]?.postMessage(accepted);
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
 * The /app document and its hashed assets, cache-first, so the app boots
 * offline. A hit is always correct: the assets are immutable, and the document
 * is replaced along with everything else when the build id changes.
 *
 * `ignoreSearch` because a query string doesn't change which prerendered
 * document applies, and `ignoreVary` because the precached responses were
 * stored against a fetch, not against this request's headers.
 */
async function serveShell(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);

  const cached = await cache.match(request, {
    ignoreSearch: true,
    ignoreVary: true,
  });
  if (cached) return cached;

  return fetch(request);
}

/**
 * A runtime or model file: cache-first, and counted on the way in from the
 * network.
 */
async function serveAsset(
  event: SwFetchEvent,
  request: Request,
  rule: AssetRule,
): Promise<Response> {
  const cache = await caches.open(MODELS_CACHE);

  const cached = await cache.match(request, { ignoreVary: true });
  // Handed back untouched, so the browser streams it straight off disk.
  // Counting would put every chunk of several gigabytes through this worker's
  // JS on every warm-up, for a bar nobody is looking at — only a preload
  // reports progress, and there `runTogether` in lib/preload fills a step's
  // share of the bar when it finishes, so one that reports nothing still
  // completes it.
  if (cached) return cached;

  const response = await fetch(request);

  // A range response or an error is not something to store or measure, and
  // cache.put would reject on it anyway.
  if (!response.ok || response.status !== 200 || !response.body) {
    return response;
  }

  const total = contentLength(response);

  // One body, two consumers: the caller gets a counted stream, the cache gets
  // the raw bytes. waitUntil keeps the worker alive for the write even if the
  // caller abandons its branch.
  const [forCaller, forCache] = response.body.tee();

  event.waitUntil(
    // A rejection here (quota, most likely, on a file this size) leaves the
    // bytes unstored while the step still succeeds and writes its marker. So
    // it is recorded against the step, which `hasStep` believes over the
    // marker — otherwise the next visit would think the model is on disk and
    // quietly download it again.
    //
    // Keyed by the request, not `response.url` — huggingface.co 302-redirects
    // to its LFS CDN, and the redirected URL is not what anything asks for.
    cache
      .put(request, new Response(forCache, responseInit(response)))
      .catch((err) => {
        console.warn('Asset cache write failed:', request.url, err);
        return markWriteFailed(rule.step);
      }),
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
