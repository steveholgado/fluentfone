import { describe, expect, it } from 'vitest';

import { formatTurnTimings } from '#/lib/utils/formatTurnTimings';

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

  it('breaks down transcription and synthesis when their timings are known', () => {
    expect(
      formatTurnTimings(
        {
          start: 1000,
          stopped: 1006,
          transcribed: 4362,
          generating: 4368,
          generated: 5223,
          synthesised: 7689,
          stt: { decode: 40.4, inference: 3290.6, device: 'webgpu' },
          tts: { startup: 925.5, synthesis: 1540.2 },
        },
        62,
      ),
    ).toBe(
      'stop 6 · stt 3356 (decode 40, whisper 3291 on webgpu) · gen 861 (setup 6) · tts 2466 (startup 926, synthesis 1540) · first audio 6689ms · reply 62 chars',
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
