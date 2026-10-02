/**
 * Asks the browser not to evict this origin's storage.
 *
 * Without it the models sit in "best-effort" storage, which the browser may
 * clear under disk pressure (Chrome) or after a stretch without a visit
 * (Safari, outside an installed web app). Nothing breaks when that happens —
 * the markers go with the bytes they vouch for, so the next visit just sees an
 * empty cache — but it costs the user a silent multi-gigabyte re-download.
 *
 * Called on every load of the app, not just the visit that downloads. Chrome
 * and Safari decide by their own engagement heuristics without asking, often
 * saying no on a first visit and yes once the site is used more, and a no
 * isn't remembered — so asking again is free and is what eventually gets the
 * grant. A grant covers the whole origin, bytes already on disk included.
 *
 * Firefox is knowingly left out: it answers with a permission prompt, which it
 * only shows with user activation, and a page load has none. Asking it would
 * mean calling this from a click instead.
 *
 * Window-only — `persist()` isn't exposed in workers, so the service worker
 * can't ask for itself. Never rejects: a refusal, or a browser without the
 * API, leaves storage best-effort, which the app already copes with.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
      return false;
    }

    // Already granted on an earlier visit: nothing to ask, and nothing to log
    // on every load.
    if (await navigator.storage.persisted?.()) return true;

    const granted = await navigator.storage.persist();
    console.info('Persistent storage:', granted ? 'granted' : 'denied');
    return granted;
  } catch (err) {
    console.warn('Persistent storage request failed (continuing):', err);
    return false;
  }
}
