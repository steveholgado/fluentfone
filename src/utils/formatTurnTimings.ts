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
}

/**
 * One line saying where the wait between releasing the button and hearing the
 * reply went, e.g.
 * `stop 40 · stt 900 · gen 2100 (setup 120) · tts 1400 · first audio 4440ms · reply 86 chars`.
 *
 * Transcription includes decoding the recording, which happens on the main
 * thread before the worker sees it. The reply's length is there because
 * generation and synthesis both scale with it, so turns can be compared.
 */
export function formatTurnTimings(t: TurnTimings, replyLength: number): string {
  const ms = (from: number, to: number) => Math.round(to - from);

  const setup =
    t.generating === undefined
      ? ''
      : ` (setup ${ms(t.transcribed, t.generating)})`;

  return [
    `stop ${ms(t.start, t.stopped)}`,
    `stt ${ms(t.stopped, t.transcribed)}`,
    `gen ${ms(t.transcribed, t.generated)}${setup}`,
    `tts ${ms(t.generated, t.synthesised)}`,
    `first audio ${ms(t.start, t.synthesised)}ms`,
    `reply ${replyLength} chars`,
  ].join(' · ');
}
