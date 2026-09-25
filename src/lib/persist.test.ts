import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestPersistentStorage } from '#/lib/persist';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('requestPersistentStorage', () => {
  it('reports what the browser granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('reports a refusal', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: vi.fn().mockResolvedValue(false) },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it('asks synchronously, so the click still counts as user activation', () => {
    // Firefox only shows its prompt while the click's activation is live.
    // Anything awaited first would spend it.
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', { storage: { persist } });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    void requestPersistentStorage();

    expect(persist).toHaveBeenCalledOnce();
  });

  it('reports false where the browser has no StorageManager', async () => {
    vi.stubGlobal('navigator', {});

    await expect(requestPersistentStorage()).resolves.toBe(false);
  });

  it('reports false rather than rejecting when the request throws', async () => {
    vi.stubGlobal('navigator', {
      storage: { persist: vi.fn().mockRejectedValue(new Error('blocked')) },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(requestPersistentStorage()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
