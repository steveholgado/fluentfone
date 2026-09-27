import * as speechToText from '#/lib/speech-to-text';
import * as chat from '#/lib/chat';
import * as textToSpeech from '#/lib/text-to-speech';
import { clearWriteFailed } from '#/lib/cache/markers';
import type { LoadProgress } from '#/lib/progress';
import { trackStep } from './track';
import { DOWNLOAD_ORDER, STEPS_BY_LABEL } from './steps';
import type { PreloadLabel, PreloadStatus, PreloadStepId } from './steps';

// This file is the preload tier's public API, so the step vocabulary defined
// next door in steps.ts is re-exported through it — the UI reads
// DOWNLOAD_ORDER and PreloadStatus from `#/lib/preload` alongside everything
// else here, rather than reaching past it.
export { DOWNLOAD_ORDER, STEPS_BY_LABEL };
export type { PreloadLabel, PreloadStatus, PreloadStepId };

/**
 * Downloads everything the conversation needs — the wasm runtimes and the
 * three model files (Piper, Whisper, Gemma) — so the first real conversation
 * turn doesn't pay any download cost. Runs sequentially, since they compete
 * for bandwidth, smallest first, so the progress indicator shows real movement
 * quickly instead of stalling on the (much larger) chat model first.
 *
 * Sequential is also what makes progress attributable: the service worker
 * reports bytes for whatever it is streaming, and the step currently being
 * awaited is what those bytes belong to. Running two steps at once would mix
 * them together.
 *
 * Deliberately stops short of warming up (compiling/initializing) the chat
 * engine — that's a separate, slower step left for generateMessage() to do on
 * demand, e.g. while generating the greeting.
 *
 * When preload isn't needed at all (everything's already cached), this is
 * still the only place warm up ever happens.
 */
const START: LoadProgress = { loaded: 0, total: 1, progress: 0 };
const DONE: LoadProgress = { loaded: 1, total: 1, progress: 1 };

export async function preloadAll(
  voiceId: string,
  onProgress?: (step: PreloadStepId, p: LoadProgress) => void,
): Promise<void> {
  await runStep(
    'text-to-speech-runtime',
    () => textToSpeech.preloadRuntime(),
    onProgress,
  );
  await runStep(
    'text-to-speech',
    () => textToSpeech.preload(voiceId),
    onProgress,
  );
  await runStep('speech-to-text', () => speechToText.preload(), onProgress);
  await runStep('chat-runtime', () => chat.preloadRuntime(), onProgress);
  await runStep('chat', () => chat.preload(), onProgress);
}

/**
 * Runs one step with its own progress subscription, bracketed by START and
 * DONE.
 *
 * Both ends are emitted whatever the step itself reported, and the opening
 * START is the load-bearing one: without it a step that reports no bytes never
 * touches the UI at all, so the screen keeps rendering the *previous* step's
 * DONE — a full bar reading "Finishing up…" for however long this step takes.
 * A silent step is not a hypothetical, either: it is what a step served
 * entirely from cache used to be, and what any step becomes the moment its
 * bytes arrive somewhere the service worker can't see them.
 *
 * The terminal DONE is what the "Finishing up…" state legitimately keys off,
 * while the step does its unreported tail work (compiling, writing to disk).
 */
async function runStep(
  step: PreloadStepId,
  work: () => Promise<unknown>,
  onProgress?: (step: PreloadStepId, p: LoadProgress) => void,
): Promise<void> {
  onProgress?.(step, START);

  // Every write this run makes is tested afresh: a failure recorded by an
  // earlier run must not outlive a retry that succeeds, and one this run hits
  // is recorded again. Before the work, so it can't erase this run's own.
  await clearWriteFailed(step);

  const stop = trackStep(step, (p) => onProgress?.(step, p));

  try {
    await work();
  } finally {
    stop();
  }

  onProgress?.(step, DONE);
}

/**
 * Reports which downloads are already available locally, without fetching
 * anything.
 *
 * Every step but one answers the same way: a marker in the service worker's
 * models cache, written when the step finished and stored alongside the bytes
 * it vouches for. The exception is the Piper voice, which piper-tts-web keeps
 * in OPFS where we can read it directly — a better answer than a marker, so
 * it is used instead.
 *
 * A "true" here means the *files* are on disk, not that the engine is
 * compiled and resident in memory.
 */
export async function checkPreloaded(voiceId: string): Promise<PreloadStatus> {
  const [
    textToSpeechRuntime,
    textToSpeechCached,
    speechToTextCached,
    chatRuntime,
    chatCached,
  ] = await Promise.all([
    settle(textToSpeech.isRuntimeCached()),
    settle(textToSpeech.isCached(voiceId)),
    settle(speechToText.isCached()),
    settle(chat.isRuntimeCached()),
    settle(chat.isCached()),
  ]);

  return {
    'text-to-speech-runtime': textToSpeechRuntime,
    'text-to-speech': textToSpeechCached,
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
