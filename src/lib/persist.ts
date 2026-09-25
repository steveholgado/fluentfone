/**
 * Asks the browser not to evict this origin's storage.
 *
 * Without it the models sit in "best-effort" storage, which the browser may
 * clear under disk pressure (Chrome) or after a stretch without a visit
 * (Safari, outside an installed web app). Nothing breaks when that happens —
 * the markers go with the bytes they vouch for, so the next visit just sees an
 * empty cache — but it costs the user a silent multi-gigabyte re-download.
 *
 * Called from the click that starts the download, and before anything is
 * awaited: Firefox answers with a permission prompt, which it only shows with
 * user activation. Chrome and Safari decide by their own rules without asking,
 * and often say no on a first visit.
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

    const granted = await navigator.storage.persist();
    console.info('Persistent storage:', granted ? 'granted' : 'denied');
    return granted;
  } catch (err) {
    console.warn('Persistent storage request failed (continuing):', err);
    return false;
  }
}
