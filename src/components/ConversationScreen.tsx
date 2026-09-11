interface ConversationScreenProps {
  isRecording: boolean;
  hasGreeted: boolean;
  isGreetingReady: boolean;
  status: string;
  onAnswer: () => void;
  onToggleRecording: () => void;
}

export function ConversationScreen({
  isRecording,
  hasGreeted,
  isGreetingReady,
  status,
  onAnswer,
  onToggleRecording,
}: ConversationScreenProps) {
  return (
    <>
      <div className="mb-4 h-32 w-32 rounded-full bg-gray-300" />
      {!hasGreeted ? (
        <>
          {!isGreetingReady ? (
            <div className="status animate-pulse">Incoming call</div>
          ) : (
            <button
              onClick={onAnswer}
              className="rounded-lg bg-gray-200 px-4 py-2 hover:bg-gray-300"
            >
              Answer
            </button>
          )}
        </>
      ) : (
        <>
          <button
            onClick={onToggleRecording}
            className="rounded-lg bg-gray-200 px-4 py-2 hover:bg-gray-300"
          >
            {isRecording ? 'Stop' : 'Start'}
          </button>
          <div className="status">{status}</div>
        </>
      )}
    </>
  );
}
