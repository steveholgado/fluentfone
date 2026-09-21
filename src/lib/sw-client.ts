/**
 * Registers the service worker and — more importantly — waits until it is
 * actually controlling this page.
 *
 * The waiting is the point. A newly-registered worker does not control the
 * document that registered it; it takes over on the next navigation. On a
 * first visit that would mean the worker observing none of the downloads, on
 * exactly the visit where all of them happen. `sw.ts` calls `clients.claim()`
 * on a first install to take control early, and this resolves once that has
 * landed.
 *
 * Runs in dev as well as production. The dev worker is the same code with an
 * empty precache list, which switches off everything that touches the app
 * shell and leaves only the model tier — so there is nothing left to go stale.
 */

const SW_URL = '/sw.js';

/** How long to wait for the worker to claim this page before giving up. */
const CLAIM_TIMEOUT_MS = 10_000;

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
  // this doubles as the update check, which is what picks up an edit to sw.ts.
  await navigator.serviceWorker.register(SW_URL);

  if (navigator.serviceWorker.controller) return true;

  await navigator.serviceWorker.ready;

  // `ready` resolves on activation, which can be a beat before the claim
  // reaches this page.
  if (navigator.serviceWorker.controller) return true;

  return waitForControllerChange();
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
