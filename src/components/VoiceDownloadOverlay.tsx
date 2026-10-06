import { useState } from 'react';

import { LANGUAGES, type LanguageId } from '#/config';
import { voicePackBytes } from '#/lib/preload';
import type { PreloadProgress } from '#/hooks/usePreload';
import { DownloadProgressBar } from '#/components/DownloadProgressBar';
import { Overlay } from '#/components/Overlay';
import { formatBytes } from '#/utils/formatBytes';

interface VoiceDownloadOverlayProps {
  /** The language waiting on its voices; null hides the overlay. */
  language: LanguageId | null;
  isDownloading: boolean;
  progress: PreloadProgress | null;
  failed: boolean;
  onDownload: () => void;
  onCancel: () => void;
}

const BUTTON_CLASS =
  'w-full cursor-pointer rounded-lg bg-gray-200 px-4 py-2 text-black hover:bg-gray-300 disabled:opacity-50';

/** Asks before downloading the voices of a language switched to later on. */
export function VoiceDownloadOverlay({
  language,
  isDownloading,
  progress,
  failed,
  onDownload,
  onCancel,
}: VoiceDownloadOverlayProps) {
  // The last language asked about, kept so the overlay still has something to
  // say while it animates out after `language` has gone back to null.
  const [shown, setShown] = useState(language);
  if (language && language !== shown) setShown(language);

  if (!shown) return null;

  const { label, voiceIds } = LANGUAGES[shown];

  return (
    <Overlay visible={language !== null}>
      <div className="text-lg">Download voice</div>

      <p>
        {label} needs its own voice. It downloads about{' '}
        {formatBytes(voicePackBytes(voiceIds))}, kept on this device for next
        time.
      </p>

      {failed && <div>Download failed</div>}

      {isDownloading && progress ? (
        <DownloadProgressBar
          loaded={progress.loaded}
          total={progress.total}
          percent={progress.percent}
          isFinishing={progress.isFinishing}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <button
            onClick={onDownload}
            disabled={isDownloading}
            className={BUTTON_CLASS}
          >
            {failed ? 'Retry' : 'Download'}
          </button>
          <button
            onClick={onCancel}
            disabled={isDownloading}
            className={BUTTON_CLASS}
          >
            Cancel
          </button>
        </div>
      )}
    </Overlay>
  );
}
