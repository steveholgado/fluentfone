import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTurnTimer, type TurnMark } from '#/lib/utils/turnTimer';

const NO_GAPS = { count: 0, totalMs: 0 };

/**
 * Times a turn recorded from `recordingStarted`, with the button let go at
 * `buttonReleased`, then each mark at its time in order.
 */
function timeTurn(
  recordingStarted: number,
  buttonReleased: number,
  marks: [TurnMark, number][],
) {
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(buttonReleased);
  for (const [, time] of marks) now.mockReturnValueOnce(time);
  const timer = createTurnTimer(recordingStarted);
  for (const [name] of marks) timer.mark(name);
  now.mockRestore();
  return timer;
}

const WHOLE_TURN: [TurnMark, number][] = [
  ['transcribed', 1466],
  ['chatReady', 1469],
  ['firstSentenceGenerated', 2106.4],
  ['firstClipSynthesised', 2709],
];

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('createTurnTimer', () => {
  it('logs where the wait went, with the stages adding up to first audio', () => {
    const timer = timeTurn(-2200, 1000, WHOLE_TURN);

    timer.log({
      chars: 51,
      sentences: 2,
      gaps: { count: 1, totalMs: 340.4 },
    });

    expect(console.info).toHaveBeenCalledWith('[turn]', {
      timeToFirstAudioMs: 1709,
      transcribeMs: 466,
      chatSetupMs: 3,
      generateFirstSentenceMs: 637,
      synthesiseFirstSentenceMs: 603,
      replyGaps: 1,
      replyGapsMs: 340,
      recordingMs: 3200,
      replyChars: 51,
      replySentences: 2,
    });
  });

  it('logs nothing for a turn that never reached the voice', () => {
    const timer = timeTurn(0, 1000, [
      ['transcribed', 1466],
      ['chatReady', 1469],
    ]);

    timer.log({ chars: 0, sentences: 0, gaps: NO_GAPS });

    expect(console.info).not.toHaveBeenCalled();
  });

  it('logs nothing in production', () => {
    vi.stubEnv('DEV', false);
    const timer = timeTurn(0, 1000, WHOLE_TURN);

    timer.log({ chars: 5, sentences: 1, gaps: NO_GAPS });

    expect(console.info).not.toHaveBeenCalled();
  });
});
