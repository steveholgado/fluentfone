import { describe, expect, it } from 'vitest';

import { formatBytes } from '#/utils/formatBytes';

describe('formatBytes', () => {
  it('shows gigabytes to one decimal place', () => {
    expect(formatBytes(2_734_775_000)).toBe('2.7 GB');
    expect(formatBytes(1e9)).toBe('1.0 GB');
  });

  it('shows whole megabytes below a gigabyte', () => {
    expect(formatBytes(612_359_000)).toBe('612 MB');
    expect(formatBytes(0)).toBe('0 MB');
  });
});
