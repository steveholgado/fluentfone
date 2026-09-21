/**
 * The wire contract between the service worker, which counts bytes as they
 * stream past, and whoever is listening on the page.
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
