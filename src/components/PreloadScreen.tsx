import {
  isFullyPreloaded,
  type PreloadLabel,
  type PreloadStatus,
} from '#/lib/preload';

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
  onPreload: () => void;
  onStart: () => void;
}

export function PreloadScreen({
  cached,
  isPreloading,
  status,
  onPreload,
  onStart,
}: PreloadScreenProps) {
  const ready = isFullyPreloaded(cached);

  return (
    <>
      <h1>Models needed</h1>
      <p>These run on your device and need downloading once.</p>

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

      {ready ? (
        <button onClick={onStart}>Start</button>
      ) : (
        <button onClick={onPreload} disabled={isPreloading}>
          {isPreloading ? 'Downloading…' : 'Download models'}
        </button>
      )}
      <div className="status">{status}</div>
    </>
  );
}
