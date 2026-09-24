import { describe, expect, it } from 'vitest';

import { formatTurnTimings } from '#/utils/formatTurnTimings';

describe('formatTurnTimings', () => {
  it('reports each stage as the gap since the previous one', () => {
    expect(
      formatTurnTimings(
        {
          start: 1000,
          stopped: 1040,
          transcribed: 1940,
          generating: 2060,
          generated: 4040,
          synthesised: 5440,
        },
        86,
      ),
    ).toBe(
      'stop 40 · stt 900 · gen 2100 (setup 120) · tts 1400 · first audio 4440ms · reply 86 chars',
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
          generated: 30,
          synthesised: 40.5,
        },
        1,
      ),
    ).toBe(
      'stop 10 · stt 10 · gen 9 (setup 0) · tts 11 · first audio 41ms · reply 1 chars',
    );
  });

  it('leaves out setup when the generating stage never arrived', () => {
    expect(
      formatTurnTimings(
        {
          start: 0,
          stopped: 10,
          transcribed: 20,
          generated: 30,
          synthesised: 40,
        },
        5,
      ),
    ).toBe(
      'stop 10 · stt 10 · gen 10 · tts 10 · first audio 40ms · reply 5 chars',
    );
  });
});
