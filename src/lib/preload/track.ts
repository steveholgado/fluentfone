/**
 * Turns the service worker's raw byte counts into the `LoadProgress` the UI
 * already speaks.
 *
 * The worker reports per file, as each response streams through it, and tags
 * each report with the step its URL belongs to. A download usually spans
 * several files across several steps, all in flight at once, so they are
 * summed here into one figure — keyed by URL, so a file re-reporting replaces
 * its earlier figure rather than being counted twice.
 */

import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import type { LoadProgress, ProgressCallback } from '#/lib/progress';

import type { PreloadStepId } from './steps';

/** What each step is expected to fetch; the steps left out go uncounted. */
export type StepEstimates = Partial<Record<PreloadStepId, number>>;

export interface DownloadTracker {
  /**
   * Counts a step as fully loaded, whatever its files reported — so one that
   * came in under its estimate, or arrived where the worker couldn't see it,
   * doesn't leave the bar short of 100%.
   */
  complete: (step: PreloadStepId) => void;
  stop: () => void;
}

/**
 * Reports bytes for the steps in `estimates` until stopped.
 *
 * Each step's denominator is `max(estimate, what we have actually seen)`.
 * That matters because the progress bar never moves backwards: the worker
 * only learns a file's size when its headers arrive, so summing sizes as files
 * joined would let the total grow mid-download, and the bar would stall at
 * whatever peak it hit while the total was still short. Starting from an
 * estimate avoids the growth, and taking the max means a stale estimate is
 * corrected by observation rather than believed.
 *
 * An estimate of zero is how a caller says "this step should already be on
 * disk": it adds nothing to the total unless its bytes turn up after all.
 *
 * Silent where BroadcastChannel is unavailable, or where no service worker is
 * controlling the page — the download still happens, it just goes unreported
 * until each step completes.
 */
export function trackDownload(
  estimates: StepEstimates,
  onProgress?: ProgressCallback,
): DownloadTracker {
  if (!onProgress) return { complete: () => {}, stop: () => {} };

  const files = new Map<
    string,
    { step: PreloadStepId; loaded: number; total: number }
  >();
  const completed = new Set<PreloadStepId>();

  const emit = () => onProgress(summarize(estimates, files, completed));

  const channel =
    typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel(PROGRESS_CHANNEL);

  if (channel) {
    channel.onmessage = (event: MessageEvent<AssetProgressMessage>) => {
      const message = event.data;
      if (!(message.step in estimates)) return;

      files.set(message.url, {
        step: message.step,
        loaded: message.loaded,
        total: message.total ?? 0,
      });

      emit();
    };
  }

  return {
    complete: (step) => {
      completed.add(step);
      emit();
    },
    stop: () => channel?.close(),
  };
}

/**
 * One step on its own, against its usual estimate, until the returned function
 * is called. For a download that happens as a side effect of something else —
 * a voice's worker fetching what the cache has lost — so it says nothing at
 * all unless bytes actually arrive.
 */
export function trackStep(
  step: PreloadStepId,
  onProgress?: ProgressCallback,
): () => void {
  return trackDownload({ [step]: EXPECTED_BYTES[step] }, onProgress).stop;
}

function summarize(
  estimates: StepEstimates,
  files: Map<string, { step: PreloadStepId; loaded: number; total: number }>,
  completed: Set<PreloadStepId>,
): LoadProgress {
  let loaded = 0;
  let total = 0;

  for (const [step, estimate = 0] of Object.entries(estimates) as [
    PreloadStepId,
    number | undefined,
  ][]) {
    let stepLoaded = 0;
    let observed = 0;

    for (const file of files.values()) {
      if (file.step !== step) continue;
      stepLoaded += file.loaded;
      observed += file.total;
    }

    const stepTotal = Math.max(estimate, observed);
    total += stepTotal;
    loaded += completed.has(step) ? stepTotal : Math.min(stepLoaded, stepTotal);
  }

  return { loaded, total, progress: total > 0 ? loaded / total : 0 };
}
