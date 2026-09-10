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
      <button onClick={onToggle}>{isRecording ? 'Stop' : 'Start'}</button>
      <div className="status">{status}</div>
    </>
  );
}
