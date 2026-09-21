/**
 * The app-shell precache list, replaced at build time.
 *
 * `vite-plugin-service-worker.ts` overwrites this module's source when it
 * compiles `sw.ts`, substituting the real hashed filenames and a build id. It
 * has to be its own module rather than a `define`: `sw.ts` is also imported by
 * its test, where a bare `__PRECACHE__` identifier would be a ReferenceError.
 * Tests override it with `vi.mock('#/sw-precache', …)`.
 *
 * The values below are the development/test defaults and ship in no build.
 */

/**
 * Changes whenever the shell contents change, which is what versions the
 * `shell-<BUILD_ID>` cache and so what makes the activate-time purge drop the
 * previous deploy's entries.
 */
export const BUILD_ID = 'dev';

/**
 * Same-origin URLs fetched into the shell cache on install, as request paths
 * rather than file paths — the service worker sees `/app`, never
 * `/app/index.html`.
 */
export const PRECACHE_URLS: string[] = [];
