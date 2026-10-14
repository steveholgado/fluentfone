import { useCallback, useEffect, useRef, useState } from 'react';

import { requestPersistentStorage } from '#/lib/cache/persist';
import { checkDeviceSupport, type DeviceSupport } from '#/lib/device';
import {
  checkPreloaded,
  isFullyPreloaded,
  preloadAll,
  type PreloadStatus,
} from '#/lib/preload';
import { sweepStaleAssets } from '#/lib/preload/sweep';
import type { LoadProgress } from '#/lib/progress';
import { ensureController } from '#/lib/sw-client';

/**
 * 'checking'    — probing device support and local storage on mount
 * 'unsupported' — this device can't run the models; nothing will be downloaded
 * 'needed'      — at least one model still has to be downloaded
 * 'ready'       — everything is on disk, the conversation can start
 */
export type PreloadPhase = 'checking' | 'unsupported' | 'needed' | 'ready';

/** Progress through the whole download, for the progress bar. */
export interface PreloadProgress {
  /** Bytes in so far, across every file downloading. */
  loaded: number;
  /** Bytes the download comes to, as best known so far. */
  total: number;
  percent: number;
  /**
   * True once every byte has landed but the download hasn't resolved yet —
   * the last files still being written to disk, say. That work isn't
   * reflected in `percent`, so the bar would otherwise just sit at 100% with
   * no explanation.
   */
  isFinishing: boolean;
}

/**
 * Folds the latest report into the bar's state. Reports can arrive out of
 * order, or dip slightly as chunks land and totals firm up, so the percent and
 * the byte count only ever move forward — keeps the bar from visibly jumping
 * backward.
 */
export function advanceProgress(
  previous: PreloadProgress | null,
  p: LoadProgress,
): PreloadProgress {
  const percent = Math.max(
    previous?.percent ?? 0,
    Math.round(p.progress * 100),
  );

  return {
    loaded: Math.max(previous?.loaded ?? 0, p.loaded),
    total: p.total,
    percent,
    isFinishing: percent >= 100,
  };
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

/**
 * `voiceId` is the voice the conversation will speak with, so the one the
 * download fetches. It can change before the download starts, when the
 * language does.
 */
export function usePreload(voiceId: string) {
  const [phase, setPhase] = useState<PreloadPhase>('checking');
  const [cached, setCached] = useState<PreloadStatus>(NOTHING_CACHED);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<PreloadProgress | null>(null);
  const [isPreloading, setIsPreloading] = useState(false);
  const [support, setSupport] = useState<DeviceSupport | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // First, and before the service worker is even woken: a device that
      // can't run the models shouldn't be asked to cache gigabytes of them.
      // This is also what keeps a *previously* downloaded device out of
      // 'ready' — where the greeting would start the chat engine and throw.
      const deviceSupport = await checkDeviceSupport();
      if (cancelled) return;

      setSupport(deviceSupport);

      if (!deviceSupport.supported) {
        setStatus('Device not supported');
        setPhase('unsupported');
        return;
      }

      // On every load, whatever is cached: the first visit is asked before its
      // download, and later visits are where Chrome and Safari actually tend
      // to say yes. Not awaited: nothing below depends on the answer.
      void requestPersistentStorage();

      // The worker has to be controlling this page for it to see the downloads
      // that follow, and on a first visit it only becomes so partway through
      // startup. A false here means no caching is available — the app still
      // runs, it just re-downloads each session.
      await ensureController();
      if (cancelled) return;

      // Before the check, so the space it frees is already free by the time
      // anything asks how much there is. It never touches a current file, so
      // the check's answer is the same either way.
      await sweepStaleAssets();
      if (cancelled) return;

      const result = await checkPreloaded(voiceId);
      if (cancelled) return;

      setCached(result);

      if (isFullyPreloaded(result)) {
        // Nothing is warmed up from here. The greeting builds Whisper and the
        // voice, then the chat engine — one after the other rather than all at
        // once, which is what keeps the tab's peak memory down. Running
        // preloadAll as well would only read the files through a second time.
        setPhase('ready');
      } else {
        setPhase('needed');
      }
    })();

    return () => {
      cancelled = true;
    };
    // Mount only: a voice chosen later is checked by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps `cached` describing the voice that would be downloaded, so the
  // overlay's ticks and total stay right when the language changes. Only once
  // the first check is in, which covers the voice it started with; the phase
  // is left alone, so a voice chosen once the app is ready just downloads
  // when the conversation opens it.
  const checkedVoiceRef = useRef(voiceId);

  useEffect(() => {
    if (phase === 'checking' || phase === 'unsupported') return;
    if (voiceId === checkedVoiceRef.current) return;

    let cancelled = false;

    void checkPreloaded(voiceId).then((result) => {
      if (cancelled) return;
      checkedVoiceRef.current = voiceId;
      setCached(result);
    });

    return () => {
      cancelled = true;
    };
  }, [phase, voiceId]);

  const preload = useCallback(async () => {
    // The UI doesn't offer the button in this phase, but downloading gigabytes
    // onto a device that can't use them is worth refusing at the source too.
    if (phase === 'unsupported') return;

    setIsPreloading(true);
    setProgress(null);

    try {
      await preloadAll(
        voiceId,
        (p) => setProgress((previous) => advanceProgress(previous, p)),
        // Ticks the checklist as each step lands, rather than all at once at
        // the end — the small ones finish long before the chat model does.
        (step) => setCached((previous) => ({ ...previous, [step]: true })),
      );
      setCached(ALL_CACHED);
      setProgress(null);
    } catch (err) {
      console.error(err);
      setStatus('Preload failed');
      setProgress(null);
    } finally {
      setIsPreloading(false);
    }
  }, [phase, voiceId]);

  const start = useCallback(() => setPhase('ready'), []);

  return {
    phase,
    cached,
    status,
    progress,
    isPreloading,
    support,
    preload,
    start,
  };
}
