import { clearWriteFailed } from '#/lib/cache/markers';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import * as chat from '#/lib/chat';
import type { ProgressCallback } from '#/lib/progress';
import * as speechToText from '#/lib/speech-to-text';
import * as textToSpeech from '#/lib/text-to-speech';

import { DOWNLOAD_ORDER, STEPS_BY_LABEL } from './steps';
import type { PreloadLabel, PreloadStatus, PreloadStepId } from './steps';
import { trackDownload, type StepEstimates } from './track';

// This file is the preload tier's public API, so the step types defined next
// door in steps.ts are re-exported through it — the UI reads PreloadStatus and
// PreloadLabel from `#/lib/preload` alongside everything else here, rather
// than reaching past it.
export type { PreloadLabel, PreloadStatus, PreloadStepId };

/**
 * Downloads everything the conversation needs — the wasm runtimes and the
 * three model files (Piper, Whisper, Gemma) — so the first real conversation
 * turn doesn't pay any download cost.
 *
 * All at once rather than one after another. Nothing here builds anything, so
 * the only thing the steps share is bandwidth, and running them together
 * overlaps the gaps a sequence leaves between them — worker start-up,
 * redirects, the wait for first bytes — and any per-connection limit a CDN
 * puts on a single stream. Progress stays attributable regardless: the service
 * worker tags every report with the step its URL belongs to.
 *
 * Deliberately stops short of building anything from them — the voice's
 * session, Whisper's pipeline, the chat engine. Each holds far more while it
 * builds than it keeps, so the conversation builds them when it starts, one
 * after another (see prepareGreeting in useConversation). Only the chat
 * runtime is loaded here, not just fetched, and at tens of megabytes it can
 * share the moment with the others.
 *
 * `onProgress` hears one figure for the whole download. Its total is what the
 * check finds missing — the same figure the preload screen quoted — though
 * every step still runs: one the check calls cached costs next to nothing,
 * and one whose marker outlived its bytes downloads anyway, its bytes joining
 * the total as they're seen. `onStepDone` hears each step as it finishes, in
 * whatever order that turns out to be.
 *
 * When everything is already cached this doesn't run at all.
 */
export async function preloadAll(
  voiceId: string,
  onProgress?: ProgressCallback,
  onStepDone?: (step: PreloadStepId) => void,
): Promise<void> {
  const cached = await checkPreloaded(voiceId);

  await runTogether(
    [
      {
        step: 'text-to-speech-runtime',
        work: () => textToSpeech.preloadRuntime(),
      },
      { step: 'text-to-speech', work: () => textToSpeech.preload(voiceId) },
      { step: 'speech-to-text', work: () => speechToText.preload() },
      { step: 'chat-runtime', work: () => chat.preloadRuntime() },
      { step: 'chat', work: () => chat.preload() },
    ],
    Object.fromEntries(
      DOWNLOAD_ORDER.map((step) => [
        step,
        cached[step] ? 0 : EXPECTED_BYTES[step],
      ]),
    ),
    onProgress,
    onStepDone,
  );
}

interface Job {
  step: PreloadStepId;
  work: () => Promise<unknown>;
}

/**
 * Starts every job at once, under one progress subscription that sums them.
 *
 * A step is counted complete once every job behind it has resolved — a voice
 * pack is several jobs of the same step — at which point its share of the bar
 * is filled whatever its files reported. That covers a step served entirely
 * from cache (the service worker counts only network bytes) and one that came
 * in under its estimate; without it the bar would finish short and sit there.
 *
 * Settles everything before rejecting with the first failure, rather than
 * rejecting the moment one fails. The rest are left to finish, so what they
 * fetched is kept for a retry, and nothing is still downloading behind a
 * screen that says the download failed — a retry started then would fetch the
 * same files a second time.
 */
async function runTogether(
  jobs: Job[],
  estimates: StepEstimates,
  onProgress?: ProgressCallback,
  onStepDone?: (step: PreloadStepId) => void,
): Promise<void> {
  const steps = [...new Set(jobs.map((job) => job.step))];

  // Every write this run makes is tested afresh: a failure recorded by an
  // earlier run must not outlive a retry that succeeds, and one this run hits
  // is recorded again. Before the work, so it can't erase this run's own.
  await Promise.all(steps.map((step) => clearWriteFailed(step)));

  const tracker = trackDownload(estimates, onProgress);

  // Opened at zero before any bytes arrive, so the bar shows straight away
  // rather than waiting on the first report — which, for a run served from
  // cache, never comes.
  onProgress?.({
    loaded: 0,
    total: Object.values(estimates).reduce((sum, bytes) => sum + bytes, 0),
    progress: 0,
  });

  const remaining = new Map(
    steps.map((step) => [step, jobs.filter((job) => job.step === step).length]),
  );

  try {
    const results = await Promise.allSettled(
      jobs.map(async ({ step, work }) => {
        await work();

        const left = remaining.get(step)! - 1;
        remaining.set(step, left);
        if (left === 0) {
          tracker.complete(step);
          onStepDone?.(step);
        }
      }),
    );

    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    tracker.stop();
  }
}

/**
 * Reports which downloads are already available locally, without fetching
 * anything.
 *
 * Every step but one answers the same way: a marker in the service worker's
 * models cache, written when the step finished and stored alongside the bytes
 * it vouches for. The exception is the Piper voice, two files whose URLs are
 * known up front, so their cache entries are asked after directly instead.
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

/**
 * Roughly what a download would fetch, given what's already on disk — what
 * the preload screen tells the user they're agreeing to.
 */
export function bytesNeeded(status: PreloadStatus): number {
  return DOWNLOAD_ORDER.filter((step) => !status[step]).reduce(
    (sum, step) => sum + EXPECTED_BYTES[step],
    0,
  );
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

/**
 * Downloads a language's voices, for a switch to it once the app is already
 * set up. All at once, under one bar, as preloadAll does.
 *
 * Only the voices: the piper runtime they share came with preloadAll. Were
 * it gone since, the voice's worker would fetch it anyway, just unreported.
 */
export async function preloadVoicePack(
  voiceIds: readonly string[],
  onProgress?: ProgressCallback,
): Promise<void> {
  await runTogether(
    voiceIds.map((voiceId) => ({
      step: 'text-to-speech',
      work: () => textToSpeech.preload(voiceId),
    })),
    { 'text-to-speech': voicePackBytes(voiceIds) },
    onProgress,
  );
}

/**
 * Whether every voice in a pack is on disk, so a switch to its language
 * needs no download. Only reads storage.
 */
export async function isVoicePackCached(
  voiceIds: readonly string[],
): Promise<boolean> {
  const cached = await Promise.all(
    voiceIds.map((voiceId) => settle(textToSpeech.isCached(voiceId))),
  );
  return cached.every(Boolean);
}

/** Roughly what downloading a pack would fetch, for the overlay to show. */
export function voicePackBytes(voiceIds: readonly string[]): number {
  return voiceIds.length * EXPECTED_BYTES['text-to-speech'];
}

/** Treats a failed probe (no Cache Storage, …) as "not cached". */
async function settle(check: Promise<boolean>): Promise<boolean> {
  try {
    return await check;
  } catch (err) {
    console.warn('Preload check failed (assuming not cached):', err);
    return false;
  }
}
