import type { TranscribeTimings } from '#/lib/speech-to-text';
import type { SpeakTimings } from '#/lib/text-to-speech';

/**
 * `performance.now()` readings taken across one conversational turn, from the
 * moment the user stops recording to the moment the reply has been generated
 * and its first sentence is ready to play.
 */
export interface TurnTimings {
  start: number;
  stopped: number;
  transcribed: number;
  /**
   * When the model started producing tokens. Everything between `transcribed`
   * and this is setup: creating the conversation, plus loading and compiling
   * the engine on a cold turn. Absent if the 'generating' stage never arrived.
   */
  generating?: number;
  /** When the reply's first sentence was complete, and went to be spoken. */
  firstSentence: number;
  /** When the whole reply was. Can fall after `synthesised`. */
  generated: number;
  /** When the first sentence's audio was ready to play. */
  synthesised: number;
  /** How transcription's time divided up, as reported by the library. */
  stt?: TranscribeTimings;
  /** How the first sentence's synthesis divided up, as reported by the library. */
  tts?: SpeakTimings;
}

/**
 * One line saying where the wait between releasing the button and hearing the
 * reply went, e.g.
 * `stop 7 · stt 459 (decode 44, whisper 414 on webgpu) · gen 640 (setup 3, whole reply 1307) · tts 600 (startup 9, synthesis 590) · first audio 1706ms · reply 51 chars in 2 sentences`.
 *
 * `gen` and `tts` follow the first sentence, since the reply starts playing as
 * soon as that is spoken and the rest is generated and synthesised meanwhile —
 * so the four stages add up to `first audio`. `whole reply` is how long all of
 * generation took, for comparing against turns before replies were pipelined.
 *
 * Each breakdown can fall short of its stage's total; the gap is messaging
 * between threads and whatever else sits between the timed calls. The reply's
 * size is there because generation and synthesis both scale with it, so turns
 * can be compared.
 */
export function formatTurnTimings(
  t: TurnTimings,
  replyLength: number,
  sentenceCount: number,
): string {
  const ms = (from: number, to: number) => Math.round(to - from);
  const round = Math.round;

  const stt = t.stt
    ? ` (decode ${round(t.stt.decode)}, whisper ${round(t.stt.inference)} on ${t.stt.device})`
    : '';
  const setup =
    t.generating === undefined
      ? ''
      : `setup ${ms(t.transcribed, t.generating)}, `;
  const tts = t.tts
    ? ` (startup ${round(t.tts.startup)}, synthesis ${round(t.tts.synthesis)})`
    : '';

  return [
    `stop ${ms(t.start, t.stopped)}`,
    `stt ${ms(t.stopped, t.transcribed)}${stt}`,
    `gen ${ms(t.transcribed, t.firstSentence)} (${setup}whole reply ${ms(t.transcribed, t.generated)})`,
    `tts ${ms(t.firstSentence, t.synthesised)}${tts}`,
    `first audio ${ms(t.start, t.synthesised)}ms`,
    `reply ${replyLength} chars in ${sentenceCount} ${sentenceCount === 1 ? 'sentence' : 'sentences'}`,
  ].join(' · ');
}
