import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearWriteFailed,
  hasStep,
  markStep,
  markWriteFailed,
} from '#/lib/cache/markers';
import { stubCacheStorage } from '#/test-utils';

beforeEach(() => {
  stubCacheStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasStep', () => {
  it('is true once the step is marked', async () => {
    await markStep('chat', 'model-a');

    await expect(hasStep('chat', 'model-a')).resolves.toBe(true);
  });

  it('does not match a marker left under a different key', async () => {
    await markStep('chat', 'model-a');

    await expect(hasStep('chat', 'model-b')).resolves.toBe(false);
  });

  it('believes a failed write over the marker', async () => {
    // The step resolved and marked itself done, but the service worker could
    // not store its bytes. Trusting the marker is what used to send the app
    // straight to ready and re-download gigabytes in the background.
    await markStep('chat', 'model-a');
    await markWriteFailed('chat');

    await expect(hasStep('chat', 'model-a')).resolves.toBe(false);
  });

  it('believes a failed write recorded before the marker, too', async () => {
    // The cache write can reject either side of the step finishing.
    await markWriteFailed('chat');
    await markStep('chat', 'model-a');

    await expect(hasStep('chat', 'model-a')).resolves.toBe(false);
  });

  it('trusts the marker again once the failure is cleared', async () => {
    await markStep('chat', 'model-a');
    await markWriteFailed('chat');

    await clearWriteFailed('chat');

    await expect(hasStep('chat', 'model-a')).resolves.toBe(true);
  });

  it('does not let one step’s failure affect another', async () => {
    await markStep('chat', 'model-a');
    await markStep('speech-to-text', 'whisper');
    await markWriteFailed('chat');

    await expect(hasStep('speech-to-text', 'whisper')).resolves.toBe(true);
  });

  it('is false where there is no Cache Storage', async () => {
    vi.unstubAllGlobals();

    await expect(hasStep('chat', 'model-a')).resolves.toBe(false);
  });
});

describe('markWriteFailed and clearWriteFailed', () => {
  it('never reject, whatever storage does', async () => {
    const buckets = stubCacheStorage();
    vi.mocked(caches.open).mockRejectedValue(new Error('storage gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(markWriteFailed('chat')).resolves.toBeUndefined();
    await expect(clearWriteFailed('chat')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(buckets.size).toBe(0);
    warn.mockRestore();
  });

  it('do nothing where there is no Cache Storage', async () => {
    vi.unstubAllGlobals();

    await expect(markWriteFailed('chat')).resolves.toBeUndefined();
    await expect(clearWriteFailed('chat')).resolves.toBeUndefined();
  });
});
