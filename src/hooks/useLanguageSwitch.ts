import { useCallback, useRef, useState } from 'react';

import { LANGUAGES, type LanguageId } from '#/config';
import { isVoicePackCached, preloadVoicePack } from '#/lib/preload';
import type { PreloadPhase, PreloadProgress } from '#/hooks/usePreload';

interface LanguageSwitchOptions {
  phase: PreloadPhase;
  language: LanguageId;
  setLanguage: (language: LanguageId) => void;
}

/**
 * Switches language without ever landing on one whose voices aren't on disk.
 *
 * A language whose pack is already downloaded is switched to straight away,
 * and so is any language before the app is set up: the first-run download
 * fetches whichever voice is chosen when it starts. Otherwise the language
 * waits, `pending`, until the user agrees to download its pack and the
 * download succeeds; until then the current language, and its call, carry on.
 */
export function useLanguageSwitch({
  phase,
  language,
  setLanguage,
}: LanguageSwitchOptions) {
  const [pending, setPending] = useState<LanguageId | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState<PreloadProgress | null>(null);
  const [failed, setFailed] = useState(false);

  // As in usePreload: never report a lower percent for the voice currently
  // downloading, so the bar can't jump backward.
  const maxPercentRef = useRef({ index: 0, percent: 0 });

  const request = useCallback(
    async (next: LanguageId) => {
      if (next === language) return;

      if (
        phase !== 'ready' ||
        (await isVoicePackCached(LANGUAGES[next].voiceIds))
      ) {
        setLanguage(next);
        return;
      }

      setFailed(false);
      setPending(next);
    },
    [phase, language, setLanguage],
  );

  const confirm = useCallback(async () => {
    if (!pending || isDownloading) return;

    const { voiceIds } = LANGUAGES[pending];
    setIsDownloading(true);
    setFailed(false);
    maxPercentRef.current = { index: 0, percent: 0 };

    try {
      await preloadVoicePack(voiceIds, (position, p) => {
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
          total: voiceIds.length,
          percent: maxPercentRef.current.percent,
          isFinishing: maxPercentRef.current.percent >= 100,
        });
      });
      setLanguage(pending);
      setPending(null);
    } catch (err) {
      console.error('Voice download failed:', err);
      setFailed(true);
    } finally {
      setIsDownloading(false);
      setProgress(null);
    }
  }, [pending, isDownloading, setLanguage]);

  /**
   * Keeps the current language. Refused mid-download: stopping the voice's
   * worker part way could leave a partial file that would pass for the
   * voice next time.
   */
  const cancel = useCallback(() => {
    if (isDownloading) return;
    setPending(null);
    setFailed(false);
  }, [isDownloading]);

  return { pending, isDownloading, progress, failed, request, confirm, cancel };
}
