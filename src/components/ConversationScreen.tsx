import { Waveform } from '#/components/Waveform';

interface ConversationScreenProps {
  isRecording: boolean;
  isAudioLive: boolean;
  hasGreeted: boolean;
  isGreetingReady: boolean;
  canRepeat: boolean;
  /** The goodbye has been spoken: no more turns, but it can be repeated. */
  hasEnded: boolean;
  /** The line being repeated, while its text is showing. */
  transcript?: string | null;
  status: string;
  minimal?: boolean;
  onAnswer: () => void;
  onToggleRecording: () => void;
  onRepeat: () => void;
  onShowText: () => void;
  onCallAgain: () => void;
}

const REPEAT_BUTTON_CLASS =
  'cursor-pointer rounded-lg border border-gray-300 px-4 py-1.5 text-base text-gray-200 hover:bg-white/10';

const CALL_BUTTON_CLASS =
  'min-w-48 cursor-pointer rounded-lg bg-gray-200 px-8 py-3 text-xl text-black hover:bg-gray-300';

export function ConversationScreen({
  isRecording,
  isAudioLive,
  hasGreeted,
  isGreetingReady,
  canRepeat,
  hasEnded,
  transcript = null,
  status,
  minimal = false,
  onAnswer,
  onToggleRecording,
  onRepeat,
  onShowText,
  onCallAgain,
}: ConversationScreenProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-between px-8 py-16 sm:py-32">
      <div className="flex flex-col items-center gap-4">
        <div className="mb-4 h-40 w-40 rounded-full bg-gray-300" />
        <div className="text-2xl">Example Name</div>
      </div>
      {minimal ? null : !hasGreeted ? (
        <>
          <div className="animate-pulse text-center text-2xl">
            {/* Before the call connects there's the engine to compile and the
                greeting to generate, neither of which reports progress.
                `status` says which of those is happening; 'Connecting' covers
                the gap before the first stage is reported. */}
            {isGreetingReady ? 'Incoming call' : status || 'Connecting'}
          </div>
          <button
            onClick={onAnswer}
            className="min-w-48 cursor-pointer rounded-lg bg-gray-200 px-8 py-3 text-xl text-black hover:bg-gray-300 disabled:bg-gray-500"
            disabled={!isGreetingReady}
          >
            Answer
          </button>
        </>
      ) : (
        <>
          {/* The text outlasts the audio by a moment, so it's checked first:
              the repeat buttons only come back once it has gone. */}
          {transcript !== null || isAudioLive ? (
            <>
              {transcript !== null ? (
                // Scrolls rather than grows, so a long reply can't push the
                // Start button around.
                <p className="max-h-48 max-w-prose overflow-y-auto text-center text-xl">
                  {transcript}
                </p>
              ) : (
                <Waveform />
              )}
              {/* The waveform has taken the status line's place, so the cue it
                  was carrying needs somewhere else to live. sr-only is out of
                  flow, so it costs the layout nothing. */}
              <span className="sr-only">{status}</span>
            </>
          ) : canRepeat && !status ? (
            <div className="flex flex-col gap-3">
              {hasEnded && (
                <div className="mb-3 text-center text-2xl">Call ended</div>
              )}
              <button onClick={onRepeat} className={REPEAT_BUTTON_CLASS}>
                Repeat
              </button>
              <button onClick={onShowText} className={REPEAT_BUTTON_CLASS}>
                Read along
              </button>
            </div>
          ) : (
            <div className="text-center text-2xl">{status}</div>
          )}
          {hasEnded ? (
            <button onClick={onCallAgain} className={CALL_BUTTON_CLASS}>
              Call again
            </button>
          ) : (
            <button onClick={onToggleRecording} className={CALL_BUTTON_CLASS}>
              {isRecording ? 'Stop' : 'Start'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
