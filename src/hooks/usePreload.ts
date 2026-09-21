import { useCallback, useEffect, useRef, useState } from 'react';

import {
  checkPreloaded,
  DOWNLOAD_ORDER,
  isFullyPreloaded,
  preloadAll,
  type PreloadStatus,
} from '#/lib/preload';
import { ensureController } from '#/lib/sw-client';
import { VOICE_ID } from '#/config';

/**
 * 'checking' — probing local storage on mount
 * 'needed'   — at least one model still has to be downloaded
 * 'ready'    — everything is on disk, the conversation can start
 */
export type PreloadPhase = 'checking' | 'needed' | 'ready';

/** Progress through the current model download, for the progress bar. */
export interface PreloadProgress {
  /** 1-based position of the model currently downloading. */
  index: number;
  total: number;
  percent: number;
  /**
   * True once this model's bytes have fully landed but its preload step
   * hasn't resolved yet — e.g. compiling/initializing the engine, or writing
   * the file to disk. That work isn't reflected in `percent`, so the bar
   * would otherwise just sit at 100% with no explanation.
   */
  isFinishing: boolean;
}

const NOTHING_CACHED: PreloadStatus = {
  'text-to-speech-runtime': false,
  'text-to-speech': false,
  'speech-to-text': false,
  'chat-runtime': false,
  chat: false,
};

const ALL_CACHED: PreloadStatus = {
  'text-to-speech-runtime': true,
  'text-to-speech': true,
  'speech-to-text': true,
  'chat-runtime': true,
  chat: true,
};

export function usePreload() {
  const [phase, setPhase] = useState<PreloadPhase>('checking');
  const [cached, setCached] = useState<PreloadStatus>(NOTHING_CACHED);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<PreloadProgress | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Before anything is probed or fetched. The worker has to be controlling
      // this page for it to see the downloads that follow, and on a first
      // visit it only becomes so partway through startup. A false here means
      // no caching is available — the app still runs, it just re-downloads
      // each session.
      await ensureController();
      if (cancelled) return;

      const result = await checkPreloaded(VOICE_ID);
      if (cancelled) return;

      setCached(result);

      if (isFullyPreloaded(result)) {
        setPhase('ready');
        // Everything is downloaded, but the engines still have to be created
        // and compiled. Do that now, off-screen, so the first conversation
        // turn doesn't pay for it. Reads from cache, so no network cost.
        void preloadAll(VOICE_ID).catch((err) => {
          console.error('Background warm-up failed:', err);
        });
      } else {
        setPhase('needed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Progress can be reported out of order or dip slightly as chunks land, so
  // track the highest percent seen for the model currently downloading and
  // never report a lower one — keeps the bar from visibly jumping backward.
  const maxPercentRef = useRef({ index: 0, percent: 0 });

  const preload = useCallback(async () => {
    setIsPreloading(true);
    maxPercentRef.current = { index: 0, percent: 0 };

    // Every step gets a slot, including ones the check said were already
    // cached. preloadAll runs all of them regardless of what the check found,
    // so a step whose marker claims it is on disk while the bytes are not —
    // a cache write that failed after the marker was written, say — would
    // otherwise download in full with no slot to report into, leaving the bar
    // frozen on the previous step. Steps that really are cached cost a slot
    // the bar passes through in a frame.
    try {
      await preloadAll(VOICE_ID, (step, p) => {
        const position = DOWNLOAD_ORDER.indexOf(step);
        if (position === -1) return;
        const index = position + 1;

        const rawPercent = Math.round(p.progress * 100);

        if (index !== maxPercentRef.current.index) {
          maxPercentRef.current = { index, percent: rawPercent };
        } else {
          maxPercentRef.current.percent = Math.max(
            maxPercentRef.current.percent,
            rawPercent,
          );
        }

        setProgress({
          index,
          total: DOWNLOAD_ORDER.length,
          percent: maxPercentRef.current.percent,
          // All of this step's bytes are in, but preloadAll() hasn't moved
          // on to the next step yet — it's still inside this one's preload()
          // call, past the download and into whatever unreported work comes
          // after (compiling/initializing, writing to disk).
          isFinishing: maxPercentRef.current.percent >= 100,
        });
      });
      setCached(ALL_CACHED);
      setProgress(null);
    } catch (err) {
      console.error(err);
      setStatus('Preload failed');
      setProgress(null);
    } finally {
      setIsPreloading(false);
    }
  }, []);

  const start = useCallback(() => setPhase('ready'), []);

  return { phase, cached, status, progress, isPreloading, preload, start };
}
