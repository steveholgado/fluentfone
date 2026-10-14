import { formatBytes } from '#/utils/formatBytes';

interface DownloadProgressBarProps {
  loaded: number;
  total: number;
  percent: number;
  isFinishing?: boolean;
}

/**
 * The fill shows how far along the download is, so the text gives the bytes
 * rather than repeating it as a percentage. The percentage still goes to
 * assistive tech, through the progressbar role.
 */
export function DownloadProgressBar({
  loaded,
  total,
  percent,
  isFinishing = false,
}: DownloadProgressBarProps) {
  return (
    <div
      // A styled div, since <progress> can't be styled consistently across
      // browsers.
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label="Download progress"
      className="relative w-full overflow-hidden rounded-lg bg-gray-200 px-4 py-2 text-black"
    >
      <div
        className="absolute inset-y-0 left-0 bg-gray-400 transition-[width]"
        style={{ width: `${percent}%` }}
      />
      <div className="relative flex justify-between">
        <span className={isFinishing ? 'animate-pulse' : undefined}>
          {isFinishing ? 'Finishing up' : 'Downloading'}
        </span>
        {/* Tabular figures, so the count doesn't shuffle sideways as its
            digits change. */}
        <span className="tabular-nums">
          {`${formatBytes(loaded)} of ${formatBytes(total)}`}
        </span>
      </div>
    </div>
  );
}
