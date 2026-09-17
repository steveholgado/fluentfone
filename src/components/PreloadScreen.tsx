import { useEffect, useState } from 'react';

import {
  isFullyPreloaded,
  type PreloadLabel,
  type PreloadStatus,
} from '#/lib/preload';
import type { PreloadProgress } from '#/hooks/usePreload';
import { cn } from '#/utils/cn';
import { DownloadProgressBar } from '#/components/DownloadProgressBar';

const LABELS: Record<PreloadLabel, string> = {
  'speech-to-text': 'Speech-to-text',
  chat: 'Chat',
  'text-to-speech': 'Text-to-speech',
};

const ORDER: PreloadLabel[] = ['speech-to-text', 'chat', 'text-to-speech'];

interface PreloadScreenProps {
  cached: PreloadStatus;
  isPreloading: boolean;
  status: string;
  progress: PreloadProgress | null;
  visible: boolean;
  onPreload: () => void;
  onStart: () => void;
}

export function PreloadScreen({
  cached,
  isPreloading,
  status,
  progress,
  visible,
  onPreload,
  onStart,
}: PreloadScreenProps) {
  const ready = isFullyPreloaded(cached);
  const [shouldRender, setShouldRender] = useState(visible);

  useEffect(() => {
    if (visible) setShouldRender(true);
  }, [visible]);

  if (!shouldRender) return null;

  return (
    <div className="absolute inset-0 h-full w-full">
      <div
        className={cn(
          'absolute inset-0 bg-neutral-800/90',
          !visible && 'animate-fade-out [animation-delay:300ms]',
        )}
        onAnimationEnd={() => {
          if (!visible) setShouldRender(false);
        }}
      />

      <div
        className={cn(
          'absolute right-4 bottom-4 left-4 flex flex-col gap-4 rounded-4xl bg-white p-8 text-black',
          visible ? 'animate-scale-in' : 'animate-scale-out',
        )}
      >
        <div className="text-lg">Download</div>
        <ul>
          {ORDER.map((label) => (
            <li key={label}>
              <span aria-hidden="true">{cached[label] ? '✓' : '✗'}</span>{' '}
              {LABELS[label]}
              <span className="sr-only">
                {cached[label] ? ' downloaded' : ' not downloaded'}
              </span>
            </li>
          ))}
        </ul>

        {!!status && <div>{status}</div>}

        {ready ? (
          <button
            onClick={onStart}
            className="w-full cursor-pointer rounded-lg bg-gray-200 px-4 py-2 text-black hover:bg-gray-300"
          >
            Start
          </button>
        ) : isPreloading && progress ? (
          <DownloadProgressBar
            current={progress.index}
            total={progress.total}
            percent={progress.percent}
            isFinishing={progress.isFinishing}
          />
        ) : (
          <button
            onClick={onPreload}
            disabled={isPreloading}
            className="w-full cursor-pointer rounded-lg bg-gray-200 px-4 py-2 text-black hover:bg-gray-300 disabled:opacity-50"
          >
            Download
          </button>
        )}
      </div>
    </div>
  );
}
