import { createFileRoute, Link } from '@tanstack/react-router';

import { PreloadScreen } from '#/components/PreloadScreen';
import { ConversationScreen } from '#/components/ConversationScreen';
import { useConversation } from '#/hooks/useConversation';
import { usePreload } from '#/hooks/usePreload';

export const Route = createFileRoute('/app')({ ssr: false, component: App });

function App() {
  const {
    phase,
    cached,
    status: preloadStatus,
    isPreloading,
    preload,
    start,
  } = usePreload();
  const { isRecording, hasGreeted, status, greet, toggleRecording } =
    useConversation();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      {phase === 'checking' && <div>Checking for downloaded models…</div>}

      {phase === 'needed' && (
        <PreloadScreen
          cached={cached}
          isPreloading={isPreloading}
          status={preloadStatus}
          onPreload={() => void preload()}
          onStart={start}
        />
      )}

      {phase === 'ready' && (
        <ConversationScreen
          isRecording={isRecording}
          hasGreeted={hasGreeted}
          status={status}
          onAnswer={greet}
          onToggleRecording={toggleRecording}
        />
      )}
    </main>
  );
}
