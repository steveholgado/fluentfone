/**
 * The LiteRT-LM web SDK (early preview) doesn't persist a downloaded model
 * across page loads — `Engine.create()` just fetches whatever URL you give
 * it every time. To avoid re-downloading the (large) .litertlm file on every
 * reload, we fetch it ourselves through the Cache Storage API, which
 * survives reloads/restarts, and hand `Engine.create()` a Blob instead of a
 * URL. See: https://developer.chrome.com/docs/ai/cache-models
 */

import type { LoadProgress, ProgressCallback } from '../progress';

const MODEL_CACHE_NAME = 'litert-lm-models-v1';

export async function fetchModelAsBlob(
  modelUrl: string,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (typeof caches === 'undefined') {
    const response = await fetch(modelUrl);
    if (!response.ok)
      throw new Error(
        `Failed to download model (${response.status}): ${modelUrl}`,
      );
    return readWithProgress(response, onProgress);
  }

  const cache = await caches.open(MODEL_CACHE_NAME);
  const cached = await cache.match(modelUrl);
  if (cached) {
    const blob = await cached.blob();
    onProgress?.({ loaded: blob.size, total: blob.size, progress: 1 });
    return blob;
  }

  // Free up quota before pulling down a new model.
  await evictOtherCachedModels(modelUrl);

  const response = await fetch(modelUrl);
  if (!response.ok)
    throw new Error(
      `Failed to download model (${response.status}): ${modelUrl}`,
    );

  const responseForCache = response.clone();
  const blob = await readWithProgress(response, onProgress);

  try {
    await cache.put(modelUrl, responseForCache);
  } catch (err) {
    console.warn('Model caching failed (continuing without cache):', err);
  }

  return blob;
}

/** Whether the model file at modelUrl is already in the Cache Storage. */
export async function hasCachedModel(modelUrl: string): Promise<boolean> {
  if (typeof caches === 'undefined') return false;

  const cache = await caches.open(MODEL_CACHE_NAME);
  return (await cache.match(modelUrl)) !== undefined;
}

/** Reads a Response body via its stream, reporting byte progress as it goes. */
async function readWithProgress(
  response: Response,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  if (!onProgress || !response.body) {
    return response.blob();
  }

  const totalHeader = response.headers.get('Content-Length');
  const total = totalHeader ? Number(totalHeader) : undefined;

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const progress: LoadProgress = {
      loaded,
      total,
      progress: total ? loaded / total : undefined,
    };
    onProgress(progress);
  }

  return new Blob(chunks);
}

/** Removes any cached model entries other than the one at keepUrl. */
async function evictOtherCachedModels(keepUrl: string): Promise<void> {
  if (typeof caches === 'undefined') return;

  const cache = await caches.open(MODEL_CACHE_NAME);
  const requests = await cache.keys();

  await Promise.all(
    requests
      .filter((req) => req.url !== keepUrl)
      .map((req) => cache.delete(req)),
  );
}

/** Removes any cached model file(s) downloaded via fetchModelAsBlob(). */
export async function clearModelCache(): Promise<void> {
  if (typeof caches !== 'undefined') {
    await caches.delete(MODEL_CACHE_NAME);
  }
}
