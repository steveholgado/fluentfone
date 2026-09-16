import { useCallback, useEffect, useRef, useState } from 'react';

import {
  checkPreloaded,
  DOWNLOAD_ORDER,
  isFullyPreloaded,
  preloadAll,
  type PreloadStatus,
} from '#/lib/preload';
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
}

const NOTHING_CACHED: PreloadStatus = {
  'speech-to-text': false,
  chat: false,
  'text-to-speech': false,
};

const ALL_CACHED: PreloadStatus = {
  'speech-to-text': true,
  chat: true,
  'text-to-speech': true,
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

    // Only labels not already cached get a slot in the progress bar.
    const needed = DOWNLOAD_ORDER.filter((label) => !cached[label]);

    try {
      await preloadAll(VOICE_ID, (label, p) => {
        const position = needed.indexOf(label);
        if (position === -1) return;
        const index = position + 1;

        const rawPercent =
          typeof p.progress === 'number' ? Math.round(p.progress * 100) : 0;

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
          total: needed.length,
          percent: maxPercentRef.current.percent,
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
  }, [cached]);

  const start = useCallback(() => setPhase('ready'), []);

  return { phase, cached, status, progress, isPreloading, preload, start };
}
