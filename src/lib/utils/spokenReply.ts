import type { Voice } from '#/lib/text-to-speech';
import { createSentenceSplitter } from '#/lib/utils/sentenceSplitter';

/**
 * Speaks a reply a sentence at a time as it's generated: each sentence goes
 * to the voice the moment it's complete, and plays once its audio is back and
 * the one before has finished. So the first sentence plays while the rest is
 * still being generated and synthesised, rather than after all of it.
 *
 * Sentences are synthesised in parallel but always played in order. Once one
 * fails, nothing after it plays.
 */
export interface SpokenReply {
  /** Adds the next piece of generated text. */
  push(chunk: string): void;
  /**
   * Flushes the last sentence, and resolves once every sentence has played
   * with what was spoken: the sentences, the clips played for them, and the
   * gaps between them. Rejects with the first failure, to synthesis or
   * playback.
   */
  end(): Promise<{ sentences: string[]; clips: Blob[]; gaps: ReplyGaps }>;
  /**
   * Resolves once whatever has already gone to be spoken has finished,
   * failures included. For when generation fails partway: what has started
   * is let finish before the failure shows.
   */
  settle(): Promise<void>;
}

/**
 * Silences partway through the reply, where one sentence had finished playing
 * and the next wasn't ready: still being generated, or still being
 * synthesised. The wait before the first sentence isn't one of them.
 */
export interface ReplyGaps {
  count: number;
  totalMs: number;
}

// Anything shorter is the hand-off from one clip to the next, not a wait.
const MIN_GAP_MS = 10;

export interface SpokenReplyOptions {
  voice: Pick<Voice, 'speak'>;
  /** The whole reply is at one speed. */
  speed: number;
  play: (clip: Blob) => Promise<void>;
  /** When the first sentence is complete, and goes to be spoken. */
  onFirstSentence?: () => void;
  /** When the first sentence's audio is back, just before it plays. */
  onFirstClip?: () => void;
}

export function createSpokenReply({
  voice,
  speed,
  play,
  onFirstSentence,
  onFirstClip,
}: SpokenReplyOptions): SpokenReply {
  const sentences: string[] = [];
  const clips: Blob[] = [];
  const gaps: ReplyGaps = { count: 0, totalMs: 0 };
  let lastPlayEnded: number | undefined;
  let playback = Promise.resolve();

  const splitter = createSentenceSplitter((sentence) => {
    const isFirst = sentences.push(sentence) === 1;
    if (isFirst) onFirstSentence?.();

    const audio = voice.speak(sentence, { speed });
    // Its failure surfaces through `playback`, which awaits it in turn.
    audio.catch(() => {});

    playback = playback.then(async () => {
      const clip = await audio;
      if (isFirst) onFirstClip?.();
      clips.push(clip);
      if (lastPlayEnded !== undefined) {
        const gap = performance.now() - lastPlayEnded;
        if (gap >= MIN_GAP_MS) {
          gaps.count += 1;
          gaps.totalMs += gap;
        }
      }
      await play(clip);
      lastPlayEnded = performance.now();
    });
    // Awaited by end() or settle(); until then a failure would otherwise be
    // reported as unhandled.
    playback.catch(() => {});
  });

  return {
    push(chunk) {
      splitter.push(chunk);
    },

    async end() {
      splitter.end();
      await playback;
      return { sentences, clips, gaps };
    },

    settle() {
      return playback.catch(() => {});
    },
  };
}
