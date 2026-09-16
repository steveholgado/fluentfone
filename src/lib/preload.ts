import * as speechToText from './speech-to-text';
import * as chat from './chat';
import * as textToSpeech from './text-to-speech';
import type { LoadProgress } from './progress';

export type PreloadLabel = 'speech-to-text' | 'chat' | 'text-to-speech';

/** Which models are already downloaded, keyed by label. */
export type PreloadStatus = Record<PreloadLabel, boolean>;

/**
 * Warms up all three models (Whisper, Gemma, Piper) so the first real
 * conversation turn doesn't pay any download/compile cost. Runs
 * sequentially — they compete for bandwidth and GPU memory — smallest first,
 * so the progress indicator shows real movement quickly instead of stalling
 * on the (much larger) chat model first.
 */
export async function preloadAll(
  voiceId: string,
  onProgress?: (label: PreloadLabel, p: LoadProgress) => void,
): Promise<void> {
  await textToSpeech.preload(voiceId, (p) => onProgress?.('text-to-speech', p));
  await speechToText.preload((p) => onProgress?.('speech-to-text', p));
  await chat.preload((p) => onProgress?.('chat', p));
}

/**
 * Reports which of the three models are already available locally, without
 * downloading anything. Each model persists somewhere different — the chat
 * model in Cache Storage, Whisper in Transformers.js' own Cache Storage
 * bucket, the Piper voice in OPFS — so each library answers for itself.
 *
 * A "true" here means the *files* are on disk, not that the engine is
 * compiled and resident in memory.
 */
export async function checkPreloaded(voiceId: string): Promise<PreloadStatus> {
  const [speechToTextCached, chatCached, textToSpeechCached] =
    await Promise.all([
      settle(speechToText.isCached()),
      settle(chat.isCached()),
      settle(textToSpeech.isCached(voiceId)),
    ]);

  return {
    'speech-to-text': speechToTextCached,
    chat: chatCached,
    'text-to-speech': textToSpeechCached,
  };
}

export function isFullyPreloaded(status: PreloadStatus): boolean {
  return Object.values(status).every(Boolean);
}

/** Treats a failed probe (no OPFS, no Cache Storage, …) as "not cached". */
async function settle(check: Promise<boolean>): Promise<boolean> {
  try {
    return await check;
  } catch (err) {
    console.warn('Preload check failed (assuming not cached):', err);
    return false;
  }
}
