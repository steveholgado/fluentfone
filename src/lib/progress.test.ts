import { describe, expect, it } from 'vitest';

import { formatProgress } from '#/lib/progress';

describe('formatProgress', () => {
  it('formats an exact progress fraction as a whole percentage', () => {
    expect(formatProgress({ loaded: 50, total: 100, progress: 0.5 })).toBe(
      '50%',
    );
  });

  it('rounds down a repeating-decimal percentage', () => {
    expect(formatProgress({ loaded: 1, total: 3, progress: 1 / 3 })).toBe(
      '33%',
    );
  });

  it('falls back to megabytes when progress is unknown', () => {
    expect(formatProgress({ loaded: 2_500_000 })).toBe('2.5 MB');
  });
});
