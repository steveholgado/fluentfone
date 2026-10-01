import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LANGUAGES, type LanguageId } from '#/config';
import { useLanguageSwitch } from '#/hooks/useLanguageSwitch';
import type { PreloadPhase } from '#/hooks/usePreload';
import { requestPersistentStorage } from '#/lib/persist';
import { isVoicePackCached, preloadVoicePack } from '#/lib/preload';

vi.mock('#/lib/persist', () => ({
  requestPersistentStorage: vi.fn().mockResolvedValue(false),
}));

vi.mock('#/lib/preload', () => ({
  isVoicePackCached: vi.fn(),
  preloadVoicePack: vi.fn(),
}));

const setLanguage = vi.fn();

function renderSwitch(phase: PreloadPhase = 'ready') {
  return renderHook(() =>
    useLanguageSwitch({ phase, language: 'es-ES', setLanguage }),
  );
}

/** Asks for `language`, then lets the cache check settle. */
async function request(
  result: { current: ReturnType<typeof useLanguageSwitch> },
  language: LanguageId,
) {
  await act(async () => {
    await result.current.request(language);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isVoicePackCached).mockResolvedValue(false);
  vi.mocked(preloadVoicePack).mockResolvedValue(undefined);
});

describe('useLanguageSwitch', () => {
  it('ignores the language already chosen', async () => {
    const { result } = renderSwitch();

    await request(result, 'es-ES');

    expect(setLanguage).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
  });

  it('switches straight away when the voices are on disk', async () => {
    vi.mocked(isVoicePackCached).mockResolvedValue(true);
    const { result } = renderSwitch();

    await request(result, 'es-MX');

    expect(isVoicePackCached).toHaveBeenCalledWith(LANGUAGES['es-MX'].voiceIds);
    expect(setLanguage).toHaveBeenCalledWith('es-MX');
    expect(result.current.pending).toBeNull();
  });

  it('switches straight away before the first download, which will fetch it', async () => {
    const { result } = renderSwitch('needed');

    await request(result, 'es-MX');

    expect(setLanguage).toHaveBeenCalledWith('es-MX');
    expect(result.current.pending).toBeNull();
  });

  it('holds a language whose voices are missing, without switching', async () => {
    const { result } = renderSwitch();

    await request(result, 'es-MX');

    expect(result.current.pending).toBe('es-MX');
    expect(setLanguage).not.toHaveBeenCalled();
    expect(preloadVoicePack).not.toHaveBeenCalled();
  });

  it('keeps the current language on cancel', async () => {
    const { result } = renderSwitch();
    await request(result, 'es-MX');

    act(() => result.current.cancel());

    expect(result.current.pending).toBeNull();
    expect(setLanguage).not.toHaveBeenCalled();
  });

  describe('confirm', () => {
    it('downloads the voices, then switches', async () => {
      const { result } = renderSwitch();
      await request(result, 'es-MX');

      await act(async () => {
        await result.current.confirm();
      });

      expect(preloadVoicePack).toHaveBeenCalledWith(
        LANGUAGES['es-MX'].voiceIds,
        expect.any(Function),
      );
      expect(setLanguage).toHaveBeenCalledWith('es-MX');
      expect(result.current.pending).toBeNull();
      expect(result.current.isDownloading).toBe(false);
      expect(result.current.failed).toBe(false);
    });

    it('asks for persistent storage before the download', async () => {
      const order: string[] = [];
      vi.mocked(requestPersistentStorage).mockImplementation(async () => {
        order.push('persist');
        return false;
      });
      vi.mocked(preloadVoicePack).mockImplementation(async () => {
        order.push('download');
      });
      const { result } = renderSwitch();
      await request(result, 'es-MX');

      await act(async () => {
        await result.current.confirm();
      });

      expect(order).toEqual(['persist', 'download']);
    });

    it('reports progress as a 1-based voice of the pack, never going backward', async () => {
      let report!: Parameters<typeof preloadVoicePack>[1];
      let finish!: () => void;
      vi.mocked(preloadVoicePack).mockImplementation(
        (_voiceIds, onProgress) => {
          report = onProgress;
          return new Promise<void>((resolve) => (finish = resolve));
        },
      );
      const { result } = renderSwitch();
      await request(result, 'es-MX');

      let confirming!: Promise<void>;
      act(() => {
        confirming = result.current.confirm();
      });
      act(() => report?.(0, { loaded: 60, total: 100, progress: 0.6 }));
      act(() => report?.(0, { loaded: 40, total: 100, progress: 0.4 }));

      expect(result.current.isDownloading).toBe(true);
      expect(result.current.progress).toEqual({
        index: 1,
        total: LANGUAGES['es-MX'].voiceIds.length,
        percent: 60,
        isFinishing: false,
      });

      act(() => report?.(0, { loaded: 100, total: 100, progress: 1 }));
      expect(result.current.progress?.isFinishing).toBe(true);

      await act(async () => {
        finish();
        await confirming;
      });
      expect(result.current.progress).toBeNull();
    });

    it('stays on the current language when the download fails, offering a retry', async () => {
      vi.mocked(preloadVoicePack).mockRejectedValueOnce(new Error('offline'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { result } = renderSwitch();
      await request(result, 'es-MX');

      await act(async () => {
        await result.current.confirm();
      });

      expect(setLanguage).not.toHaveBeenCalled();
      expect(result.current.pending).toBe('es-MX');
      expect(result.current.failed).toBe(true);
      expect(result.current.isDownloading).toBe(false);

      await act(async () => {
        await result.current.confirm();
      });

      expect(setLanguage).toHaveBeenCalledWith('es-MX');
      expect(result.current.failed).toBe(false);

      errorSpy.mockRestore();
    });

    it('cannot be cancelled mid-download', async () => {
      let finish!: () => void;
      vi.mocked(preloadVoicePack).mockImplementation(
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      const { result } = renderSwitch();
      await request(result, 'es-MX');

      let confirming!: Promise<void>;
      act(() => {
        confirming = result.current.confirm();
      });
      act(() => result.current.cancel());

      expect(result.current.pending).toBe('es-MX');

      await act(async () => {
        finish();
        await confirming;
      });
      expect(setLanguage).toHaveBeenCalledWith('es-MX');
    });

    it('does nothing with no language waiting', async () => {
      const { result } = renderSwitch();

      await act(async () => {
        await result.current.confirm();
      });

      expect(preloadVoicePack).not.toHaveBeenCalled();
    });
  });
});
