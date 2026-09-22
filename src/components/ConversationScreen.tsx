import { Waveform } from '#/components/Waveform';

interface ConversationScreenProps {
  isRecording: boolean;
  isAudioLive: boolean;
  hasGreeted: boolean;
  isGreetingReady: boolean;
  status: string;
  onAnswer: () => void;
  onToggleRecording: () => void;
}

export function ConversationScreen({
  isRecording,
  isAudioLive,
  hasGreeted,
  isGreetingReady,
  status,
  onAnswer,
  onToggleRecording,
}: ConversationScreenProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-between px-8 py-16 sm:py-32">
      <div className="flex flex-col items-center gap-4">
        <div className="mb-4 h-40 w-40 rounded-full bg-gray-300" />
        <div className="text-2xl">Example Name</div>
      </div>
      {!hasGreeted ? (
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
          {isAudioLive ? (
            <>
              <Waveform />
              {/* The waveform has taken the status line's place, so the cue it
                  was carrying needs somewhere else to live. sr-only is out of
                  flow, so it costs the layout nothing. */}
              <span className="sr-only">{status}</span>
            </>
          ) : (
            <div className="text-center text-2xl">{status}</div>
          )}
          <button
            onClick={onToggleRecording}
            className="min-w-48 cursor-pointer rounded-lg bg-gray-200 px-8 py-3 text-xl text-black hover:bg-gray-300"
          >
            {isRecording ? 'Stop' : 'Start'}
          </button>
        </>
      )}
    </div>
  );
}
