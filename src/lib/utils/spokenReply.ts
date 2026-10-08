import type { SpeakTimings, Voice } from '#/lib/text-to-speech';
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
   * with what was spoken: the sentences, and the clips played for them.
   * Rejects with the first failure, to synthesis or playback.
   */
  end(): Promise<{ sentences: string[]; clips: Blob[] }>;
  /**
   * Resolves once whatever has already gone to be spoken has finished,
   * failures included. For when generation fails partway: what has started
   * is let finish before the failure shows.
   */
  settle(): Promise<void>;
}

export interface SpokenReplyOptions {
  voice: Pick<Voice, 'speak'>;
  /** The whole reply is at one speed. */
  speed: number;
  play: (clip: Blob) => Promise<void>;
  /** When the first sentence is complete, and goes to be spoken. */
  onFirstSentence?: () => void;
  /**
   * When the first sentence's audio is back, just before it plays, with how
   * its synthesis divided up.
   */
  onFirstClip?: (timings: SpeakTimings | undefined) => void;
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
  let playback = Promise.resolve();

  const splitter = createSentenceSplitter((sentence) => {
    const isFirst = sentences.push(sentence) === 1;
    if (isFirst) onFirstSentence?.();

    let timings: SpeakTimings | undefined;
    const audio = voice.speak(sentence, {
      speed,
      onTimings: (t) => (timings = t),
    });
    // Its failure surfaces through `playback`, which awaits it in turn.
    audio.catch(() => {});

    playback = playback.then(async () => {
      const clip = await audio;
      if (isFirst) onFirstClip?.(timings);
      clips.push(clip);
      await play(clip);
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
      return { sentences, clips };
    },

    settle() {
      return playback.catch(() => {});
    },
  };
}
