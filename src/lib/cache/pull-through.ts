/**
 * Fetches every file in full so the service worker stores it. Nothing is kept
 * here — the bytes are wanted on disk, not in memory.
 *
 * Drained rather than buffered: `arrayBuffer()` would hold each file whole
 * only to throw it away, and for the chat model that means one contiguous
 * allocation of gigabytes, which fails often enough to reject a download that
 * succeeded. Whisper's encoder and decoder are hundreds of megabytes each.
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
