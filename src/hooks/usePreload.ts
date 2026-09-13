import { useCallback, useEffect, useState } from 'react';

import {
  checkPreloaded,
  isFullyPreloaded,
  preloadAll,
  type PreloadStatus,
} from '#/lib/preload';
import { formatProgress } from '#/lib/progress';
import { VOICE_ID } from '#/config';

/**
 * 'checking' — probing local storage on mount
 * 'needed'   — at least one model still has to be downloaded
 * 'ready'    — everything is on disk, the conversation can start
 */
export type PreloadPhase = 'checking' | 'needed' | 'ready';

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

  const preload = useCallback(async () => {
    setIsPreloading(true);

    try {
      await preloadAll(VOICE_ID, (label, p) =>
        setStatus(`Preloading ${label}… ${formatProgress(p)}`),
      );
      setCached(ALL_CACHED);
      setStatus('');
    } catch (err) {
      console.error(err);
      setStatus('Preload failed — see console.');
    } finally {
      setIsPreloading(false);
    }
  }, []);

  const start = useCallback(() => setPhase('ready'), []);

  return { phase, cached, status, isPreloading, preload, start };
}
