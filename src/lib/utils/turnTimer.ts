import type { ReplyGaps } from '#/lib/utils/spokenReply';

/**
 * Moments in one conversational turn, after the user lets go of the button.
 * The timer marks that itself, as it's created.
 */
export type TurnMark =
  /** Whisper's text is back. */
  | 'transcribed'
  /**
   * The chat model is ready to generate: its engine loaded and compiled on a
   * cold turn, and the conversation created or reused.
   */
  | 'chatReady'
  /** The reply's first sentence is complete, and goes to be spoken. */
  | 'firstSentenceGenerated'
  /** That sentence's audio is ready to play. */
  | 'firstClipSynthesised';

export interface TurnTimer {
  mark(name: TurnMark): void;
  /**
   * In dev only, logs where the turn's time went, as `[turn] { ... }`:
   *
   * - `timeToFirstAudioMs`: from letting go of the button to the reply's
   *   first audio being ready. The four that follow add up to it.
   * - `transcribeMs`: stopping the recorder, and Whisper.
   * - `chatSetupMs`: getting the chat model ready. Near zero once it's warm.
   * - `generateFirstSentenceMs`, `synthesiseFirstSentenceMs`: the reply
   *   starts playing once its first sentence is spoken, while the rest is
   *   still being generated and synthesised.
   * - `replyGaps`, `replyGapsMs`: silences partway through the reply, waiting
   *   on the next sentence. See {@link ReplyGaps}.
   * - `recordingMs`, `replyChars`, `replySentences`: the turn's size, since
   *   transcription scales with the first and generation and synthesis with
   *   the others, so turns can be compared.
   */
  log(reply: { chars: number; sentences: number; gaps: ReplyGaps }): void;
}

/**
 * Starts timing a turn as the user lets go of the button, given when they
 * started recording it.
 */
export function createTurnTimer(recordingStarted: number): TurnTimer {
  const marks: Partial<Record<TurnMark, number>> = {};
  const buttonReleased = performance.now();

  return {
    mark(name) {
      marks[name] = performance.now();
    },

    log({ chars, sentences, gaps }) {
      if (!import.meta.env.DEV) return;

      const at = (mark: TurnMark) => marks[mark] ?? NaN;
      const ms = (from: number, to: number) => Math.round(to - from);
      const entry = {
        timeToFirstAudioMs: ms(buttonReleased, at('firstClipSynthesised')),
        transcribeMs: ms(buttonReleased, at('transcribed')),
        chatSetupMs: ms(at('transcribed'), at('chatReady')),
        generateFirstSentenceMs: ms(
          at('chatReady'),
          at('firstSentenceGenerated'),
        ),
        synthesiseFirstSentenceMs: ms(
          at('firstSentenceGenerated'),
          at('firstClipSynthesised'),
        ),
        replyGaps: gaps.count,
        replyGapsMs: Math.round(gaps.totalMs),
        recordingMs: ms(recordingStarted, buttonReleased),
        replyChars: chars,
        replySentences: sentences,
      };

      // A turn that never reached the voice, like an empty reply, has
      // nothing to time.
      if (Object.values(entry).some(Number.isNaN)) return;
      console.info('[turn]', entry);
    },
  };
}
