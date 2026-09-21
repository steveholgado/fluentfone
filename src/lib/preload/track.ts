/**
 * Turns the service worker's raw byte counts into the `LoadProgress` the UI
 * already speaks.
 *
 * The worker reports per file, as each response streams through it. A step
 * usually spans several files downloaded together, so they are summed here —
 * keyed by URL, so a file re-reporting replaces its earlier figure rather than
 * being counted twice.
 */

import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import type { LoadProgress, ProgressCallback } from '#/lib/progress';
import type { PreloadStepId } from './steps';

/**
 * Reports bytes for `step` until the returned function is called.
 *
 * The denominator is `max(estimate, what we have actually seen)`. That
 * matters because the progress bar never moves backwards: the worker only
 * learns a file's size when its headers arrive, so summing sizes as files
 * joined would let the total grow mid-step, and the bar would stall at
 * whatever peak it hit while the total was still short. Starting from an
 * estimate avoids the growth, and taking the max means a stale estimate is
 * corrected by observation rather than believed.
 *
 * A no-op where BroadcastChannel is unavailable, or where no service worker is
 * controlling the page — the download still happens, it just goes unreported.
 */
export function trackStep(
  step: PreloadStepId,
  onProgress?: ProgressCallback,
): () => void {
  if (!onProgress || typeof BroadcastChannel === 'undefined') {
    return () => {};
  }

  const files = new Map<string, { loaded: number; total: number }>();
  const channel = new BroadcastChannel(PROGRESS_CHANNEL);

  channel.onmessage = (event: MessageEvent<AssetProgressMessage>) => {
    const message = event.data;
    if (message.step !== step) return;

    files.set(message.url, {
      loaded: message.loaded,
      total: message.total ?? 0,
    });

    onProgress(summarize(step, files));
  };

  return () => channel.close();
}

function summarize(
  step: PreloadStepId,
  files: Map<string, { loaded: number; total: number }>,
): LoadProgress {
  let loaded = 0;
  let observed = 0;

  for (const file of files.values()) {
    loaded += file.loaded;
    observed += file.total;
  }

  const total = Math.max(EXPECTED_BYTES[step] ?? 0, observed);

  return {
    loaded,
    // A step whose files all arrived without a Content-Length and has no
    // estimate reports an unknown total, rather than a number the bar would
    // overrun.
    total: total || undefined,
    progress: total ? Math.min(loaded / total, 1) : undefined,
  };
}
