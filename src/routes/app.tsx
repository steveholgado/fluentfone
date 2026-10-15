import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { CheckScreen } from '#/components/CheckScreen';
import { Conversation } from '#/components/Conversation';
import { Header } from '#/components/Header';
import { PreloadOverlay } from '#/components/PreloadOverlay';
import { SettingsMenu } from '#/components/SettingsMenu';
import { UnsupportedOverlay } from '#/components/UnsupportedOverlay';
import { VoiceDownloadOverlay } from '#/components/VoiceDownloadOverlay';
import { voiceFor } from '#/config';
import { useLanguageSwitch } from '#/hooks/useLanguageSwitch';
import { usePreload } from '#/hooks/usePreload';
import { useSettings } from '#/hooks/useSettings';

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
  // Counts calls made with Call again, so each has a key of its own.
  const [callId, setCallId] = useState(0);

  return (
    <main className="flex h-dvh flex-col bg-neutral-900 text-white sm:px-4 sm:pb-4">
      <Header />

      {/* A size container, so the screens inside can scale with the card's
          height rather than the window's, which also counts the header. On
          mobile the card is a sheet under the header, flush with the sides
          and bottom; from sm up it's inset and rounded all round. */}
      <div className="@container-size relative min-h-0 flex-1 overflow-hidden rounded-t-3xl bg-neutral-800 sm:rounded-3xl">
        {/* Nothing to set until there's going to be a call. Nor while a
            language waits on its voices: the switch saves the settings as they
            were when it was asked for, so a change made meanwhile would be
            lost. */}
        {phase !== 'checking' &&
          phase !== 'unsupported' &&
          languageSwitch.pending === null && (
            <div className="absolute top-4 right-4 z-10">
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

        {phase === 'checking' && <CheckScreen />}

        {/* Keyed by language and level: a new one of either is a new call, so
            everything from the last one — history, greeting, anything still
            in flight — goes. Call again does the same by bumping callId. The
            chat engine and Whisper live in workers outside it, so they stay
            loaded; the voice's worker is closed on unmount, before the new
            call opens its own. */}
        {phase !== 'checking' && (
          <Conversation
            key={`${language}:${level}:${callId}`}
            level={level}
            language={language}
            speed={speed}
            phase={phase}
            onCallAgain={() => setCallId((id) => id + 1)}
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
