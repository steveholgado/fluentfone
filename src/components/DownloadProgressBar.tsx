interface DownloadProgressBarProps {
  current: number;
  total: number;
  percent: number;
  isFinishing?: boolean;
}

export function DownloadProgressBar({
  current,
  total,
  percent,
  isFinishing = false,
}: DownloadProgressBarProps) {
  return (
    <div className="relative w-full overflow-hidden rounded-lg bg-gray-200 px-4 py-2 text-black">
      <div
        className="absolute inset-y-0 left-0 bg-gray-400 transition-[width]"
        style={{ width: `${percent}%` }}
      />
      <div className="relative flex justify-between">
        <span className={isFinishing ? 'animate-pulse' : undefined}>
          {isFinishing
            ? 'Finishing up...'
            : `Downloading ${current} of ${total}`}
        </span>
        <span>{percent}%</span>
      </div>
    </div>
  );
}
