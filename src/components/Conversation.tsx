import { useEffect } from 'react';

import { ConversationScreen } from '#/components/ConversationScreen';
import { useConversation } from '#/hooks/useConversation';
import type { LanguageId } from '#/config';
import type { PreloadPhase } from '#/hooks/usePreload';
import type { CefrLevel } from '#/prompts';

interface ConversationProps {
  level: CefrLevel;
  language: LanguageId;
  speed: number;
  phase: PreloadPhase;
}

/**
 * One conversation, from the incoming call onwards. Its level and language are
 * fixed: the caller keys this by them, so a new one is a new call.
 */
export function Conversation({
  level,
  language,
  speed,
  phase,
}: ConversationProps) {
  const {
    isRecording,
    isAudioLive,
    hasGreeted,
    isGreetingReady,
    canRepeat,
    transcript,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
    repeatLastLine,
  } = useConversation({ level, language, speed });

  useEffect(() => {
    if (phase === 'ready') void prepareGreeting();
  }, [phase, prepareGreeting]);

  return (
    <ConversationScreen
      isRecording={isRecording}
      isAudioLive={isAudioLive}
      hasGreeted={hasGreeted}
      isGreetingReady={isGreetingReady}
      canRepeat={canRepeat}
      transcript={transcript}
      status={status}
      minimal={phase !== 'ready'}
      onAnswer={greet}
      onToggleRecording={toggleRecording}
      onRepeat={() => void repeatLastLine(false)}
      onShowText={() => void repeatLastLine(true)}
    />
  );
}
