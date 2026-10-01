import { createFileRoute } from '@tanstack/react-router';

import { CheckScreen } from '#/components/CheckScreen';
import { Conversation } from '#/components/Conversation';
import { PreloadOverlay } from '#/components/PreloadOverlay';
import { SettingsMenu } from '#/components/SettingsMenu';
import { UnsupportedOverlay } from '#/components/UnsupportedOverlay';
import { VoiceDownloadOverlay } from '#/components/VoiceDownloadOverlay';
import { useLanguageSwitch } from '#/hooks/useLanguageSwitch';
import { usePreload } from '#/hooks/usePreload';
import { useSettings } from '#/hooks/useSettings';
import { voiceFor } from '#/config';

export const Route = createFileRoute('/app')({ ssr: false, component: App });

function App() {
  const { language, level, speed, setLanguage, setLevel, setSpeed } =
    useSettings();
  const {
    phase,
    cached,
    status: preloadStatus,
    progress: preloadProgress,
    isPreloading,
    support,
    preload,
    start,
  } = usePreload(voiceFor(language));
  const languageSwitch = useLanguageSwitch({ phase, language, setLanguage });

  return (
    <main className="min-h-screen sm:flex sm:items-center sm:justify-center sm:p-8">
      {/* Nothing to set until there's going to be a call. Nor while a
          language waits on its voices: the switch saves the settings as they
          were when it was asked for, so a change made meanwhile would be
          lost. */}
      {phase !== 'checking' &&
        phase !== 'unsupported' &&
        languageSwitch.pending === null && (
          <div className="fixed top-4 right-4 z-10">
            <SettingsMenu
              language={language}
              level={level}
              speed={speed}
              onLanguageChange={(next) => void languageSwitch.request(next)}
              onLevelChange={setLevel}
              onSpeedChange={setSpeed}
            />
          </div>
        )}

      <div className="relative h-screen w-full overflow-hidden bg-neutral-800 text-white sm:aspect-9/18 sm:h-auto sm:w-100 sm:rounded-[48px]">
        {phase === 'checking' && <CheckScreen />}

        {/* Keyed by language and level: a new one of either is a new call, so
            everything from the last one — history, greeting, anything still
            in flight — goes. */}
        {phase !== 'checking' && (
          <Conversation
            key={`${language}:${level}`}
            level={level}
            language={language}
            speed={speed}
            phase={phase}
          />
        )}

        <PreloadOverlay
          cached={cached}
          isPreloading={isPreloading}
          status={preloadStatus}
          progress={preloadProgress}
          visible={phase === 'needed'}
          onPreload={() => void preload()}
          onStart={start}
        />

        <VoiceDownloadOverlay
          language={languageSwitch.pending}
          isDownloading={languageSwitch.isDownloading}
          progress={languageSwitch.progress}
          failed={languageSwitch.failed}
          onDownload={() => void languageSwitch.confirm()}
          onCancel={languageSwitch.cancel}
        />

        <UnsupportedOverlay
          visible={phase === 'unsupported'}
          status={preloadStatus}
          unmet={support?.unmet ?? []}
        />
      </div>
    </main>
  );
}
