import { describe, expect, it } from 'vitest';

import { formatTurnTimings } from '#/lib/utils/formatTurnTimings';

describe('formatTurnTimings', () => {
  it('follows the first sentence, so the stages add up to first audio', () => {
    expect(
      formatTurnTimings(
        {
          start: 1000,
          stopped: 1007,
          transcribed: 1466,
          generating: 1469,
          firstSentence: 2106,
          generated: 2773,
          synthesised: 2706,
          stt: { decode: 44.2, inference: 413.6, device: 'webgpu' },
          tts: { startup: 9.4, synthesis: 590.5 },
        },
        51,
        2,
      ),
    ).toBe(
      'stop 7 · stt 459 (decode 44, whisper 414 on webgpu) · gen 640 (setup 3, whole reply 1307) · tts 600 (startup 9, synthesis 591) · first audio 1706ms · reply 51 chars in 2 sentences',
    );
  });

  it('rounds fractional milliseconds', () => {
    expect(
      formatTurnTimings(
        {
          start: 0,
          stopped: 10.4,
          transcribed: 20.6,
          generating: 21,
          firstSentence: 30,
          generated: 30,
          synthesised: 40.5,
        },
        1,
        1,
      ),
    ).toBe(
      'stop 10 · stt 10 · gen 9 (setup 0, whole reply 9) · tts 11 · first audio 41ms · reply 1 chars in 1 sentence',
    );
  });

  it('leaves out setup when the generating stage never arrived', () => {
    expect(
      formatTurnTimings(
        {
          start: 0,
          stopped: 10,
          transcribed: 20,
          firstSentence: 30,
          generated: 30,
          synthesised: 40,
        },
        5,
        1,
      ),
    ).toBe(
      'stop 10 · stt 10 · gen 10 (whole reply 10) · tts 10 · first audio 40ms · reply 5 chars in 1 sentence',
    );
  });
});
