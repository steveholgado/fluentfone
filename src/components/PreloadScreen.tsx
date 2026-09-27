import {
  bytesNeeded,
  isFullyPreloaded,
  isLabelPreloaded,
  type PreloadLabel,
  type PreloadStatus,
} from '#/lib/preload';
import type { PreloadProgress } from '#/hooks/usePreload';
import { DownloadProgressBar } from '#/components/DownloadProgressBar';
import { Notification } from '#/components/Notification';
import { formatBytes } from '#/utils/formatBytes';

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

/**
 * Shown to everyone rather than detected. Browsers deliberately hide private
 * mode, and the quota they report can't be trusted to reveal it — Brave, for
 * one, reports a fixed 2 GiB. In a normal window, any browser with WebGPU
 * allows far more than the app needs, so a private window is the case worth
 * warning about.
 */
function DownloadNote({ bytes }: { bytes: number }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg bg-amber-100 p-4 text-sm">
      <p>
        This app downloads about {formatBytes(bytes)}, kept on this device for
        next time.
      </p>
      <p>
        Private windows have a size limit, so please use a normal window.
        Otherwise the files will download again each time.
      </p>
    </div>
  );
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

  return (
    <Notification visible={visible}>
      <div className="text-lg">Download</div>
      <ul>
        {ORDER.map((label) => {
          // A row only ticks once both of its steps — the wasm runtime and
          // the model weights — are on disk.
          const done = isLabelPreloaded(cached, label);
          return (
            <li key={label}>
              <span aria-hidden="true">{done ? '✓' : '✗'}</span> {LABELS[label]}
              <span className="sr-only">
                {done ? ' downloaded' : ' not downloaded'}
              </span>
            </li>
          );
        })}
      </ul>

      {!!status && <div>{status}</div>}

      {!ready && <DownloadNote bytes={bytesNeeded(cached)} />}

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
    </Notification>
  );
}
