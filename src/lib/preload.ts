import * as speechToText from './speech-to-text';
import * as chat from './chat';
import * as textToSpeech from './text-to-speech';
import type { LoadProgress } from './progress';

/** The three capabilities, as the preload screen lists them. */
export type PreloadLabel = 'speech-to-text' | 'chat' | 'text-to-speech';

/**
 * Each capability needs two separate downloads: the wasm runtime it executes
 * on, and its model weights. They're tracked apart because they're reported
 * apart — one progress bar spanning both would have to restart its total
 * partway through, and the bar never moves backwards, so it would simply
 * stick. A step is one contiguous 0→100%.
 */
export type PreloadStepId =
  | 'text-to-speech-runtime'
  | 'text-to-speech'
  | 'speech-to-text-runtime'
  | 'speech-to-text'
  | 'chat-runtime'
  | 'chat';

/** Which downloads are already done, keyed by step. */
export type PreloadStatus = Record<PreloadStepId, boolean>;

/** The order preloadAll downloads in — smallest first. */
export const DOWNLOAD_ORDER: PreloadStepId[] = [
  'text-to-speech-runtime',
  'text-to-speech',
  'speech-to-text-runtime',
  'speech-to-text',
  'chat-runtime',
  'chat',
];

/** The steps behind each label, for rolling them up in the UI. */
export const STEPS_BY_LABEL: Record<PreloadLabel, PreloadStepId[]> = {
  'text-to-speech': ['text-to-speech-runtime', 'text-to-speech'],
  'speech-to-text': ['speech-to-text-runtime', 'speech-to-text'],
  chat: ['chat-runtime', 'chat'],
};

/**
 * Downloads everything the conversation needs — three wasm runtimes and three
 * model files (Piper, Whisper, Gemma) — so the first real conversation turn
 * doesn't pay any download cost. Runs sequentially, since they compete for
 * bandwidth, smallest first, so the progress indicator shows real movement
 * quickly instead of stalling on the (much larger) chat model first.
 *
 * Deliberately stops short of warming up (compiling/initializing) the chat
 * engine — that's a separate, slower step left for generateMessage() to do
 * on demand, e.g. while generating the greeting. What it *does* now include
 * is the download half of that work: LiteRT's wasm runtime is tens of
 * megabytes and Engine.create() fetches it silently, so leaving it until then
 * meant a long, unexplained wait in the middle of the conversation screen.
 *
 * When preload isn't needed at all (everything's already cached), this is
 * still the only place warm up ever happens.
 */
const DONE: LoadProgress = { loaded: 1, total: 1, progress: 1 };

export async function preloadAll(
  voiceId: string,
  onProgress?: (step: PreloadStepId, p: LoadProgress) => void,
): Promise<void> {
  await textToSpeech.preloadRuntime((p) =>
    onProgress?.('text-to-speech-runtime', p),
  );
  onProgress?.('text-to-speech-runtime', DONE);

  await textToSpeech.preload(voiceId, (p) => onProgress?.('text-to-speech', p));
  onProgress?.('text-to-speech', DONE);

  await speechToText.preloadRuntime((p) =>
    onProgress?.('speech-to-text-runtime', p),
  );
  onProgress?.('speech-to-text-runtime', DONE);

  await speechToText.preload((p) => onProgress?.('speech-to-text', p));
  onProgress?.('speech-to-text', DONE);

  await chat.preloadRuntime((p) => onProgress?.('chat-runtime', p));
  onProgress?.('chat-runtime', DONE);

  await chat.preload((p) => onProgress?.('chat', p));
  onProgress?.('chat', DONE);
}

/**
 * Reports which downloads are already available locally, without fetching
 * anything. Each model persists somewhere different — the chat model in Cache
 * Storage, Whisper in Transformers.js' own Cache Storage bucket, the Piper
 * voice in OPFS — so each library answers for itself.
 *
 * The runtimes are less direct: the browser's HTTP cache holds them, and it
 * can only be queried for same-origin URLs, so the two CDN-hosted runtimes
 * answer from a receipt written when they were last downloaded. See
 * lib/runtime-cache.ts for what that does and doesn't guarantee.
 *
 * A "true" here means the *files* are on disk, not that the engine is
 * compiled and resident in memory.
 */
export async function checkPreloaded(voiceId: string): Promise<PreloadStatus> {
  const [
    textToSpeechRuntime,
    textToSpeechCached,
    speechToTextRuntime,
    speechToTextCached,
    chatRuntime,
    chatCached,
  ] = await Promise.all([
    settle(textToSpeech.isRuntimeCached()),
    settle(textToSpeech.isCached(voiceId)),
    settle(speechToText.isRuntimeCached()),
    settle(speechToText.isCached()),
    settle(chat.isRuntimeCached()),
    settle(chat.isCached()),
  ]);

  return {
    'text-to-speech-runtime': textToSpeechRuntime,
    'text-to-speech': textToSpeechCached,
    'speech-to-text-runtime': speechToTextRuntime,
    'speech-to-text': speechToTextCached,
    'chat-runtime': chatRuntime,
    chat: chatCached,
  };
}

export function isFullyPreloaded(status: PreloadStatus): boolean {
  return Object.values(status).every(Boolean);
}

/** Whether every step behind a label is done — what the UI checklist shows. */
export function isLabelPreloaded(
  status: PreloadStatus,
  label: PreloadLabel,
): boolean {
  return STEPS_BY_LABEL[label].every((step) => status[step]);
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
