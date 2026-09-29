/**
 * Registers the service worker and — more importantly — waits until it is
 * actually controlling this page.
 *
 * The waiting is the point. A newly-registered worker does not control the
 * document that registered it; it takes over on the next navigation. On a
 * first visit that would mean the worker observing none of the downloads, on
 * exactly the visit where all of them happen. `sw.ts` calls `clients.claim()`
 * on a first install to take control early, or when asked to by a page that a
 * hard reload loaded past it, and this resolves once that has landed.
 *
 * It is also where a new deploy is picked up: see `applyUpdate`.
 *
 * Runs in dev as well as production. The dev worker is the same code with an
 * empty precache list, which switches off everything that touches the app
 * shell and leaves only the model tier — so there is nothing left to go stale.
 */

import { CLAIM, TAKE_OVER } from '#/lib/cache/channel';

const SW_URL = '/sw.js';

/** How long to wait for the worker to claim this page before giving up. */
const CLAIM_TIMEOUT_MS = 10_000;

/**
 * How long each step of applying an update may take before the app starts
 * without it. Both are local round trips to the worker, so anything near this
 * means something is wrong; the update isn't lost, just left for a later load.
 */
const UPDATE_TIMEOUT_MS = 3_000;

let controllerPromise: Promise<boolean> | null = null;

/**
 * Resolves true once a service worker controls this page, false if service
 * workers are unavailable or too slow to take over.
 *
 * A false is not an error: the app still works, it just re-downloads
 * everything each session and cannot go offline. Memoized, so callers can ask
 * freely.
 */
export function ensureController(): Promise<boolean> {
  controllerPromise ??= resolveController().catch((err) => {
    console.warn('Service worker unavailable (continuing without):', err);
    return false;
  });

  return controllerPromise;
}

async function resolveController(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }

  // Registered in dev too. The dev worker precaches no shell and leaves every
  // module request to the dev server (see `SHELL_ENABLED` in sw.ts), so the
  // stale-chunks-and-broken-HMR hazard that used to rule this out is gone —
  // while the model caching and the byte counting, which are the only way to
  // exercise either locally, are not.
  //
  // Unconditional rather than skipped when a controller is already present:
  // the registration is where `applyUpdate` finds a waiting deploy.
  const registration = await navigator.serviceWorker.register(SW_URL);

  if (navigator.serviceWorker.controller) {
    await applyUpdate(registration);
    return true;
  }

  const { active } = await navigator.serviceWorker.ready;

  // `ready` resolves on activation, which can be a beat before the claim
  // reaches this page.
  if (navigator.serviceWorker.controller) return true;

  // Listening before asking, so the claim can't be missed. On a first install
  // the worker's own activation claims this page and the ask is redundant. But
  // after a hard reload, which loads the page past an already-active worker,
  // nothing else would: that worker won't activate again, and without the ask
  // this sits out the whole timeout and the app runs uncached.
  const claimed = waitForControllerChange();
  active?.postMessage(CLAIM);

  return claimed;
}

/**
 * Moves this page onto a newer deploy before the app starts, if one is already
 * installed and waiting.
 *
 * The browser checks for a new `sw.js` on every navigation and installs it in
 * the background, but the new worker then waits until every tab running the
 * old one has closed. A refresh isn't enough: the refreshed page is served by
 * the old worker before the old page is gone. Someone who keeps the app in a
 * pinned tab would never see a deploy. So at startup — and only then, when
 * there is nothing running that a reload could interrupt — a waiting worker is
 * asked to take over, and the page reloads into it. The reload is the point,
 * not just the switch: this page came from the previous build, whose chunks
 * the new shell doesn't have.
 *
 * Only a worker that is already waiting. This never checks for or waits on an
 * update itself, so startup never waits on the network: a deploy installs
 * during one load and is applied at the start of the next, where it costs one
 * quick reload.
 *
 * Resolves when there's nothing to apply: nothing waiting, the worker declined
 * because another tab is running the app, or it didn't answer in time. Each
 * of those leaves the update for a later load. When the update goes ahead it
 * never resolves, so the app doesn't start on a page that's about to go.
 */
async function applyUpdate(
  registration: ServiceWorkerRegistration,
): Promise<void> {
  const worker = registration.waiting;
  if (!worker) return;

  // Listening before asking, so the switch can't be missed. Kept however the
  // ask turns out: once asked, the worker may take over at any point, and this
  // page must not go on running one build under another's worker.
  const switched = new Promise<true>((resolve) => {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        location.reload();
        resolve(true);
      },
      { once: true },
    );
  });

  const accepted = await withTimeout(askToTakeOver(worker), false);
  if (!accepted) return;

  if (await withTimeout(switched, false)) {
    await new Promise<never>(() => {});
  }
}

/** Resolves with the worker's answer; see `TAKE_OVER`. */
function askToTakeOver(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data === true);
    worker.postMessage(TAKE_OVER, [channel.port2]);
  });
}

/**
 * Settles with `fallback` if `promise` hasn't within UPDATE_TIMEOUT_MS, or if
 * it rejects — as posting to a worker that has just gone redundant does.
 */
function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), UPDATE_TIMEOUT_MS);
    const settle = (value: T) => {
      clearTimeout(timer);
      resolve(value);
    };

    promise.then(settle, () => settle(fallback));
  });
}

function waitForControllerChange(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(false);
    }, CLAIM_TIMEOUT_MS);

    function onChange() {
      clearTimeout(timer);
      resolve(true);
    }

    navigator.serviceWorker.addEventListener('controllerchange', onChange, {
      once: true,
    });
  });
}
