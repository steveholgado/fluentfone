import type { TranscribeTimings } from '#/lib/speech-to-text';
import type { SpeakTimings } from '#/lib/text-to-speech';

/**
 * `performance.now()` readings taken across one conversational turn, from the
 * moment the user stops recording to the moment the reply is ready to play.
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
  generated: number;
  synthesised: number;
  /** How transcription's time divided up, as reported by the library. */
  stt?: TranscribeTimings;
  /** How synthesis's time divided up, as reported by the library. */
  tts?: SpeakTimings;
}

/**
 * One line saying where the wait between releasing the button and hearing the
 * reply went, e.g.
 * `stop 6 · stt 3356 (decode 40, whisper 3290 on webgpu) · gen 861 (setup 6) · tts 2466 (startup 900, synthesis 1540) · first audio 6691ms · reply 62 chars`.
 *
 * Each breakdown can fall short of its stage's total; the gap is messaging
 * between threads and whatever else sits between the timed calls. The reply's
 * length is there because generation and synthesis both scale with it, so
 * turns can be compared.
 */
export function formatTurnTimings(t: TurnTimings, replyLength: number): string {
  const ms = (from: number, to: number) => Math.round(to - from);
  const round = Math.round;

  const stt = t.stt
    ? ` (decode ${round(t.stt.decode)}, whisper ${round(t.stt.inference)} on ${t.stt.device})`
    : '';
  const setup =
    t.generating === undefined
      ? ''
      : ` (setup ${ms(t.transcribed, t.generating)})`;
  const tts = t.tts
    ? ` (startup ${round(t.tts.startup)}, synthesis ${round(t.tts.synthesis)})`
    : '';

  return [
    `stop ${ms(t.start, t.stopped)}`,
    `stt ${ms(t.stopped, t.transcribed)}${stt}`,
    `gen ${ms(t.transcribed, t.generated)}${setup}`,
    `tts ${ms(t.generated, t.synthesised)}${tts}`,
    `first audio ${ms(t.start, t.synthesised)}ms`,
    `reply ${replyLength} chars`,
  ].join(' · ');
}
