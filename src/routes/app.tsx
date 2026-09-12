import { useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';

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
  const {
    isRecording,
    hasGreeted,
    isGreetingReady,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
  } = useConversation();

  useEffect(() => {
    if (phase === 'ready') void prepareGreeting();
  }, [phase, prepareGreeting]);

  return (
    <main className="min-h-screen sm:flex sm:items-center sm:justify-center sm:p-8">
      <div className="flex h-full min-h-screen w-full flex-col items-center justify-center gap-4 bg-neutral-900 p-8 text-white sm:aspect-9/18 sm:h-auto sm:min-h-0 sm:w-100 sm:rounded-2xl">
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
            isGreetingReady={isGreetingReady}
            status={status}
            onAnswer={greet}
            onToggleRecording={toggleRecording}
          />
        )}
      </div>
    </main>
  );
}
