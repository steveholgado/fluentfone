import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreload } from '#/hooks/usePreload';
import { checkPreloaded, isFullyPreloaded, preloadAll } from '#/lib/preload';
import { VOICE_ID } from '#/config';

vi.mock('#/lib/preload', () => ({
  checkPreloaded: vi.fn(),
  isFullyPreloaded: vi.fn(),
  preloadAll: vi.fn(),
  DOWNLOAD_ORDER: ['text-to-speech', 'speech-to-text', 'chat'],
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usePreload', () => {
  it('starts in the checking phase', () => {
    vi.mocked(checkPreloaded).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => usePreload());

    expect(result.current.phase).toBe('checking');
    expect(result.current.isPreloading).toBe(false);
  });

  it('moves to ready and warms up in the background when everything is cached', async () => {
    const cached = {
      'speech-to-text': true,
      chat: true,
      'text-to-speech': true,
    };
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(true);
    vi.mocked(preloadAll).mockResolvedValue(undefined);

    const { result } = renderHook(() => usePreload());

    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.cached).toEqual(cached);
    expect(preloadAll).toHaveBeenCalledWith(VOICE_ID);
  });

  it('logs but does not throw when the background warm-up fails', async () => {
    vi.mocked(checkPreloaded).mockResolvedValue({
      'speech-to-text': true,
      chat: true,
      'text-to-speech': true,
    });
    vi.mocked(isFullyPreloaded).mockReturnValue(true);
    vi.mocked(preloadAll).mockRejectedValue(new Error('warm-up failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => usePreload());

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        'Background warm-up failed:',
        expect.any(Error),
      ),
    );

    errorSpy.mockRestore();
  });

  it('moves to needed when some models are not cached, without warming up', async () => {
    const cached = {
      'speech-to-text': false,
      chat: true,
      'text-to-speech': false,
    };
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(false);

    const { result } = renderHook(() => usePreload());

    await waitFor(() => expect(result.current.phase).toBe('needed'));

    expect(result.current.cached).toEqual(cached);
    expect(preloadAll).not.toHaveBeenCalled();
  });

  it('does not update state after unmount', async () => {
    let resolveCheck: (v: unknown) => void = () => {};
    vi.mocked(checkPreloaded).mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => usePreload());
    unmount();
    resolveCheck({
      'speech-to-text': true,
      chat: true,
      'text-to-speech': true,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(result.current.phase).toBe('checking');
  });

  describe('preload', () => {
    it('reports progress and marks everything cached on success', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue({
        'speech-to-text': false,
        chat: false,
        'text-to-speech': false,
      });
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('speech-to-text', { loaded: 500_000 });
        return undefined;
      });

      const { result } = renderHook(() => usePreload());
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      await act(async () => {
        await result.current.preload();
      });

      expect(result.current.isPreloading).toBe(false);
      expect(result.current.status).toBe('');
      expect(result.current.cached).toEqual({
        'speech-to-text': true,
        chat: true,
        'text-to-speech': true,
      });
      expect(result.current.phase).toBe('needed');
    });

    it('only counts models that still need downloading in progress totals', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue({
        'speech-to-text': true,
        chat: false,
        'text-to-speech': true,
      });
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload());
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      let resolvePreloadAll: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        // preloadAll still reports the already-cached models internally...
        onProgress?.('text-to-speech', { loaded: 1, total: 1, progress: 1 });
        onProgress?.('speech-to-text', { loaded: 1, total: 1, progress: 1 });
        // ...but only the one model that needed downloading should surface.
        onProgress?.('chat', {
          loaded: 500_000,
          total: 1_000_000,
          progress: 0.5,
        });
        return new Promise((resolve) => {
          resolvePreloadAll = () => resolve(undefined);
        });
      });

      act(() => {
        void result.current.preload();
      });

      await waitFor(() =>
        expect(result.current.progress).toEqual({
          index: 1,
          total: 1,
          percent: 50,
          isFinishing: false,
        }),
      );

      await act(async () => {
        resolvePreloadAll();
      });
    });

    it('marks progress as finishing once a model hits 100% but preloadAll has not moved past it', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue({
        'speech-to-text': false,
        chat: false,
        'text-to-speech': false,
      });
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload());
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      let resolvePreloadAll: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('text-to-speech', { loaded: 1, total: 1, progress: 1 });
        return new Promise((resolve) => {
          resolvePreloadAll = () => resolve(undefined);
        });
      });

      act(() => {
        void result.current.preload();
      });

      await waitFor(() =>
        expect(result.current.progress).toEqual({
          index: 1,
          total: 3,
          percent: 100,
          isFinishing: true,
        }),
      );

      await act(async () => {
        resolvePreloadAll();
      });
    });

    it('sets an error status and stops preloading on failure', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue({
        'speech-to-text': false,
        chat: false,
        'text-to-speech': false,
      });
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockRejectedValue(new Error('network error'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => usePreload());
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      await act(async () => {
        await result.current.preload();
      });

      expect(result.current.isPreloading).toBe(false);
      expect(result.current.status).toBe('Preload failed');
      expect(errorSpy).toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  describe('start', () => {
    it('moves the phase to ready', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue({
        'speech-to-text': false,
        chat: false,
        'text-to-speech': false,
      });
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload());
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      act(() => {
        result.current.start();
      });

      expect(result.current.phase).toBe('ready');
    });
  });
});
