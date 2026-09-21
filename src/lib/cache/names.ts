/**
 * The two buckets the app stores things in.
 *
 * See the note at the top of ./rules.ts for why nothing in `lib/cache` may
 * import anything heavier than a type.
 */

/**
 * There are two buckets rather than one because they have opposite lifecycles:
 * the shell is replaced wholesale on every deploy, while the models are
 * gigabytes the user agreed to download and must survive every deploy.
 * Conflating them would mean the activate-time purge had to tell them apart by
 * URL shape, and get it right every time or drop 3 GB.
 */
export function shellCacheName(buildId: string): string {
  return `shell-${buildId}`;
}

/** Matches any build's shell bucket, for the activate-time purge. */
export const SHELL_CACHE_PREFIX = 'shell-';

/**
 * Runtimes, model weights, and the markers that vouch for them. Never purged,
 * and never versioned — entries are keyed by URLs that already carry their own
 * version, so a dependency bump misses rather than matching stale bytes.
 */
export const MODELS_CACHE = 'models-v1';
