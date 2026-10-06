import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestPersistentStorage } from '#/lib/cache/persist';

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

  it('does not ask again once already granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      storage: { persist, persisted: vi.fn().mockResolvedValue(true) },
    });

    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('asks when not yet granted', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    vi.stubGlobal('navigator', {
      storage: { persist, persisted: vi.fn().mockResolvedValue(false) },
    });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(requestPersistentStorage()).resolves.toBe(true);
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
