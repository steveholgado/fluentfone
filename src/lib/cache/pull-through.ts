/**
 * Fetches every file in full so the service worker stores it. Nothing is kept
 * here — the bytes are wanted on disk, not in memory.
 *
 * Drained rather than buffered, as the chat model is (see `preloadModel` in
 * lib/chat/engine.ts): `arrayBuffer()` would hold each file whole only to
 * throw it away — Whisper's encoder and decoder are hundreds of megabytes
 * each.
 *
 * `what` names the download in the error a failed file rejects with.
 */
export async function pullThrough(urls: readonly string[], what: string) {
  await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to download ${what} (${response.status}): ${url}`,
        );
      }
      await response.body?.pipeTo(new WritableStream());
    }),
  );
}
