import { describe, expect, it } from 'vitest';

import { formatProgress } from '#/utils/formatProgress';

describe('formatProgress', () => {
  it('formats an exact progress fraction as a whole percentage', () => {
    expect(formatProgress(0.5)).toBe('50%');
  });

  it('rounds a repeating-decimal percentage', () => {
    expect(formatProgress(1 / 3)).toBe('33%');
  });

  it('formats the ends of the range', () => {
    expect(formatProgress(0)).toBe('0%');
    expect(formatProgress(1)).toBe('100%');
  });
});
