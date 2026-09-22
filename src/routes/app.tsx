import { useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { CheckScreen } from '#/components/CheckScreen';
import { PreloadScreen } from '#/components/PreloadScreen';
import { UnsupportedScreen } from '#/components/UnsupportedScreen';
import { ConversationScreen } from '#/components/ConversationScreen';
import { useConversation } from '#/hooks/useConversation';
import { usePreload } from '#/hooks/usePreload';

export const Route = createFileRoute('/app')({ ssr: false, component: App });

function App() {
  const {
    phase,
    cached,
    status: preloadStatus,
    progress: preloadProgress,
    isPreloading,
    support,
    preload,
    start,
  } = usePreload();
  const {
    isRecording,
    isAudioLive,
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
      <div className="relative h-screen w-full overflow-hidden bg-neutral-800 text-white sm:aspect-9/18 sm:h-auto sm:w-100 sm:rounded-[48px]">
        {phase === 'checking' && <CheckScreen />}

        {phase !== 'checking' && (
          <ConversationScreen
            isRecording={isRecording}
            isAudioLive={isAudioLive}
            hasGreeted={hasGreeted}
            isGreetingReady={isGreetingReady}
            status={status}
            minimal={phase !== 'ready'}
            onAnswer={greet}
            onToggleRecording={toggleRecording}
          />
        )}

        <PreloadScreen
          cached={cached}
          isPreloading={isPreloading}
          status={preloadStatus}
          progress={preloadProgress}
          visible={phase === 'needed'}
          onPreload={() => void preload()}
          onStart={start}
        />

        <UnsupportedScreen
          visible={phase === 'unsupported'}
          status={preloadStatus}
          unmet={support?.unmet ?? []}
        />
      </div>
    </main>
  );
}
