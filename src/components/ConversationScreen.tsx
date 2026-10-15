import { Waveform } from '#/components/Waveform';

interface ConversationScreenProps {
  isRecording: boolean;
  /** Something is in flight, e.g. a turn being answered. */
  isBusy: boolean;
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
  'min-w-48 cursor-pointer rounded-lg bg-gray-200 px-8 py-3 text-xl text-black hover:bg-gray-300 disabled:bg-gray-500';

export function ConversationScreen({
  isRecording,
  isBusy,
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
  // Once the call is answered, the text outlasts the audio by a moment, so
  // it's checked first: the repeat buttons only come back once it has gone.
  const stage = minimal ? null : !hasGreeted ? (
    <div className="animate-pulse text-center text-2xl">
      {/* Before the call connects there's the engine to compile and the
          greeting to generate, neither of which reports progress. `status`
          says which of those is happening; 'Connecting' covers the gap before
          the first stage is reported. */}
      {isGreetingReady ? 'Incoming call' : status || 'Connecting'}
    </div>
  ) : transcript !== null || isAudioLive ? (
    <>
      {transcript !== null ? (
        // Scrolls rather than grows, so a long reply can't push the Start
        // button around.
        <p className="max-h-full max-w-prose overflow-y-auto text-center text-xl">
          {transcript}
        </p>
      ) : (
        <Waveform />
      )}
      {/* The waveform has taken the status line's place, so the cue it was
          carrying needs somewhere else to live. sr-only is out of flow, so it
          costs the layout nothing. */}
      <span className="sr-only">{status}</span>
    </>
  ) : canRepeat && !status ? (
    <div className="flex flex-col gap-3">
      {hasEnded && <div className="mb-3 text-center text-2xl">Call ended</div>}
      <button onClick={onRepeat} className={REPEAT_BUTTON_CLASS}>
        Repeat
      </button>
      <button onClick={onShowText} className={REPEAT_BUTTON_CLASS}>
        Read along
      </button>
    </div>
  ) : (
    <div className="text-center text-2xl">{status}</div>
  );

  const action = minimal ? null : !hasGreeted ? (
    <button
      onClick={onAnswer}
      className={CALL_BUTTON_CLASS}
      disabled={!isGreetingReady}
    >
      Answer
    </button>
  ) : hasEnded ? (
    <button onClick={onCallAgain} className={CALL_BUTTON_CLASS}>
      Call again
    </button>
  ) : (
    <button
      onClick={onToggleRecording}
      className={CALL_BUTTON_CLASS}
      disabled={isBusy}
    >
      {isRecording ? 'Stop' : 'Start'}
    </button>
  );

  return (
    <div className="flex h-full w-full items-center justify-center">
      {/* Three rows that are always there, whatever's in them. Each has a
          fixed size, and the stage in the middle centres its content, so
          swapping the status for the waveform (or anything else) grows or
          shrinks around a fixed line instead of moving its neighbours. The
          stage is sized for its tallest content, the repeat buttons under
          'Call ended'; a transcript scrolls within it. */}
      <div className="grid w-full max-w-md grid-rows-[auto_clamp(9rem,28cqh,13rem)_auto] justify-items-center gap-8 px-8 py-[clamp(2rem,8cqh,6rem)]">
        <div className="flex flex-col items-center gap-4">
          <div className="mb-4 size-[clamp(6rem,18cqh,10rem)] rounded-full bg-gray-300" />
          <div className="text-2xl">Example Name</div>
        </div>
        <div className="flex min-h-0 w-full items-center justify-center">
          {stage}
        </div>
        {/* Holds the button's height while there's no button, so the
            stage doesn't shift when one arrives. */}
        <div className="h-13">{action}</div>
      </div>
    </div>
  );
}
