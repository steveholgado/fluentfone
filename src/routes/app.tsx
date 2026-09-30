import { createFileRoute } from '@tanstack/react-router';

import { CheckScreen } from '#/components/CheckScreen';
import { Conversation } from '#/components/Conversation';
import { PreloadScreen } from '#/components/PreloadScreen';
import { SettingsMenu } from '#/components/SettingsMenu';
import { UnsupportedScreen } from '#/components/UnsupportedScreen';
import { usePreload } from '#/hooks/usePreload';
import { useSettings } from '#/hooks/useSettings';

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
  const { level, speed, setLevel, setSpeed } = useSettings();

  return (
    <main className="min-h-screen sm:flex sm:items-center sm:justify-center sm:p-8">
      {/* Nothing to set until there's going to be a call. */}
      {phase !== 'checking' && phase !== 'unsupported' && (
        <div className="fixed top-4 right-4 z-10">
          <SettingsMenu
            level={level}
            speed={speed}
            onLevelChange={setLevel}
            onSpeedChange={setSpeed}
          />
        </div>
      )}

      <div className="relative h-screen w-full overflow-hidden bg-neutral-800 text-white sm:aspect-9/18 sm:h-auto sm:w-100 sm:rounded-[48px]">
        {phase === 'checking' && <CheckScreen />}

        {/* Keyed by level: a new level is a new call, so everything from the
            last one — history, greeting, anything still in flight — goes. */}
        {phase !== 'checking' && (
          <Conversation key={level} level={level} speed={speed} phase={phase} />
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
