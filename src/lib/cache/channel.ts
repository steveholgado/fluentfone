/**
 * The wire contracts between the service worker and the page: the byte counts
 * the worker broadcasts as they stream past, and the page's request that a
 * waiting update take over.
 *
 * See the note at the top of ./rules.ts for why nothing in `lib/cache` may
 * import anything heavier than a type.
 */

import type { PreloadStepId } from '#/lib/preload/steps';

/** Carries byte counts from the service worker to whoever is listening. */
export const PROGRESS_CHANNEL = 'asset-progress';

export interface AssetProgressMessage {
  step: PreloadStepId;
  url: string;
  loaded: number;
  /** Null where the response declared no Content-Length. */
  total: number | null;
}

/**
 * Posted by a starting page to a waiting worker, with a MessagePort for the
 * answer: `true` if it is taking over, `false` if another tab is still running
 * the app on the old one.
 */
export const TAKE_OVER = 'take-over';
