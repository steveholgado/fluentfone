interface ConversationScreenProps {
  isRecording: boolean;
  status: string;
  onToggle: () => void;
}

export function ConversationScreen({
  isRecording,
  status,
  onToggle,
}: ConversationScreenProps) {
  return (
    <>
      <button
        onClick={onToggle}
        className="rounded-lg bg-gray-200 px-4 py-2 hover:bg-gray-300"
      >
        {isRecording ? 'Stop' : 'Start'}
      </button>
      <div className="status">{status}</div>
    </>
  );
}
