import * as speechToText from './speech-to-text';
import * as chat from './chat';
import * as textToSpeech from './text-to-speech';
import type { LoadProgress } from './progress';

export type PreloadLabel = 'speech-to-text' | 'chat' | 'text-to-speech';

/**
 * Warms up all three models (Whisper, Gemma, Piper) so the first real
 * conversation turn doesn't pay any download/compile cost. Runs
 * sequentially — they compete for bandwidth and GPU memory.
 */
export async function preloadAll(
  voiceId: string,
  onProgress?: (label: PreloadLabel, p: LoadProgress) => void,
): Promise<void> {
  await speechToText.preload((p) => onProgress?.('speech-to-text', p));
  await chat.preload((p) => onProgress?.('chat', p));
  await textToSpeech.preload(voiceId, (p) => onProgress?.('text-to-speech', p));
}
