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

export async function hasStep(
  step: PreloadStepId,
  key: string,
): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(MODELS_CACHE);
  return (await cache.match(markerUrl(step, key))) !== undefined;
}
