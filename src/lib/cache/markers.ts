/**
 * Reading back what is already on disk: the bytes themselves, and the markers
 * that record a step having finished.
 *
 * See the note at the top of ./rules.ts for why nothing in `lib/cache` may
 * import anything heavier than a type.
 */

import { MODELS_CACHE } from './names';
import type { PreloadStepId } from '#/lib/preload/steps';

/**
 * Whether the bytes for `url` are in the models cache.
 *
 * Stronger evidence than the step marker below, and not interchangeable with
 * it: a Cache Storage write either lands whole or rejects, so an entry's
 * presence means the complete response is there — whereas a marker is written
 * by a separate call that runs happily after the write it vouches for has
 * failed. Ask this where the bytes themselves are what matters; ask `hasStep`
 * where the question is whether a step's work was done (its bytes may live
 * somewhere else entirely, as the voice's do).
 *
 * Cheap: a match reads headers, not the body, so this does not touch the
 * gigabytes it reports on.
 */
export async function hasAsset(url: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  try {
    const cache = await caches.open(MODELS_CACHE);
    // ignoreVary because the response was stored against the library's own
    // fetch, whose headers are not necessarily the ones asked about here.
    return (await cache.match(url, { ignoreVary: true })) !== undefined;
  } catch (err) {
    // Assume not cached: the caller re-fetches, which is slow but correct.
    console.warn('Asset cache probe failed (assuming not cached):', err);
    return false;
  }
}

/**
 * A marker records that a step finished. It lives in the same bucket as the
 * bytes it vouches for, which is what makes it trustworthy: browsers evict
 * storage per origin, not per entry, so a marker cannot outlive its bytes.
 *
 * `key` carries whatever makes the download distinct — a voice id, a model
 * URL, a version-stamped path — so switching model or bumping a dependency
 * misses rather than matching a stale marker.
 *
 * Cache Storage keys have to be requests, so this maps onto a URL that is
 * never fetched.
 */
function markerUrl(step: PreloadStepId, key: string): string {
  return `https://step.invalid/${step}/${encodeURIComponent(key)}`;
}

export async function markStep(
  step: PreloadStepId,
  key: string,
): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(markerUrl(step, key), new Response('1'));
  } catch (err) {
    // A missing marker only costs a redundant download next time.
    console.warn('Step marker write failed (continuing):', err);
  }
}

/**
 * A marker is only as good as the writes it vouches for, and those can fail
 * after it is written: the service worker's cache write finishes in the
 * background, often after the step has resolved and marked itself done. When
 * one fails (over quota, most likely, on files this size), the service worker
 * records it here, and `hasStep` believes that over the marker.
 *
 * Per step rather than per key — the service worker knows which step a URL
 * belongs to, but not the version a marker is keyed by — and on its own host
 * so no marker key can collide with it. Cleared at the start of each run of
 * the step (see `runStep` in lib/preload), which is what makes either order
 * safe: a failure recorded after the marker still wins, and a retry starts
 * clean but records any write of its own that fails.
 */
function failureUrl(step: PreloadStepId): string {
  return `https://write-failed.invalid/${step}`;
}

export async function markWriteFailed(step: PreloadStepId): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(failureUrl(step), new Response('1'));
  } catch (err) {
    // The marker goes on vouching for bytes that aren't there, which is what
    // happened before this record existed: a silent re-download next visit.
    console.warn('Write-failure record failed (continuing):', err);
  }
}

export async function clearWriteFailed(step: PreloadStepId): Promise<void> {
  if (typeof caches === 'undefined') return;

  try {
    const cache = await caches.open(MODELS_CACHE);
    await cache.delete(failureUrl(step));
  } catch (err) {
    // Left in place, it only makes the step look not downloaded — a redundant
    // preload screen, never a skipped one.
    console.warn('Write-failure record clear failed (continuing):', err);
  }
}

export async function hasStep(
  step: PreloadStepId,
  key: string,
): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(MODELS_CACHE);
  if ((await cache.match(failureUrl(step))) !== undefined) return false;
  return (await cache.match(markerUrl(step, key))) !== undefined;
}
