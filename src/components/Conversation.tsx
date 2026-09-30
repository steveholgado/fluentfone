import { useEffect } from 'react';

import { ConversationScreen } from '#/components/ConversationScreen';
import { useConversation } from '#/hooks/useConversation';
import type { PreloadPhase } from '#/hooks/usePreload';
import type { CefrLevel } from '#/prompts';

interface ConversationProps {
  level: CefrLevel;
  phase: PreloadPhase;
}

/**
 * One conversation, from the incoming call onwards. Its level is fixed: the
 * caller keys this by level, so a new one is a new call.
 */
export function Conversation({ level, phase }: ConversationProps) {
  const {
    isRecording,
    isAudioLive,
    hasGreeted,
    isGreetingReady,
    canRepeat,
    status,
    greet,
    prepareGreeting,
    toggleRecording,
    repeatLastLine,
  } = useConversation({ level });

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
      status={status}
      minimal={phase !== 'ready'}
      onAnswer={greet}
      onToggleRecording={toggleRecording}
      onRepeat={() => void repeatLastLine(false)}
      onRepeatSlowly={() => void repeatLastLine(true)}
    />
  );
}
