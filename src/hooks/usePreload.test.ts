import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreload } from '#/hooks/usePreload';
import { requestPersistentStorage } from '#/lib/cache/persist';
import { checkDeviceSupport, type DeviceSupport } from '#/lib/device';
import { checkPreloaded, isFullyPreloaded, preloadAll } from '#/lib/preload';
import type { PreloadStatus } from '#/lib/preload';
import { sweepStaleAssets } from '#/lib/preload/sweep';

vi.mock('#/lib/cache/persist', () => ({
  requestPersistentStorage: vi.fn().mockResolvedValue(false),
}));

vi.mock('#/lib/preload/sweep', () => ({
  sweepStaleAssets: vi.fn().mockResolvedValue(0),
}));

// Mocked rather than driven through a stubbed navigator.gpu: the real module
// reads that once, when it loads, so a per-test stub would never reach it.
vi.mock('#/lib/device', () => ({
  checkDeviceSupport: vi.fn(),
}));

const VOICE = 'es_ES-davefx-medium';
const OTHER_VOICE = 'es_MX-ald-medium';

const WEBGPU = { id: 'webgpu', label: 'WebGPU', required: true } as const;

const SUPPORTED: DeviceSupport = {
  supported: true,
  results: [{ ...WEBGPU, met: true }],
  unmet: [],
};

const UNSUPPORTED: DeviceSupport = {
  supported: false,
  results: [{ ...WEBGPU, met: false }],
  unmet: [{ ...WEBGPU, met: false }],
};

vi.mock('#/lib/preload', () => ({
  checkPreloaded: vi.fn(),
  isFullyPreloaded: vi.fn(),
  preloadAll: vi.fn(),
  DOWNLOAD_ORDER: [
    'text-to-speech-runtime',
    'text-to-speech',
    'speech-to-text',
    'chat-runtime',
    'chat',
  ],
}));

/** Every step at `value`, then whatever `overrides` says. */
function status(
  value: boolean,
  overrides: Partial<PreloadStatus> = {},
): PreloadStatus {
  return {
    'text-to-speech-runtime': value,
    'text-to-speech': value,
    'speech-to-text': value,
    'chat-runtime': value,
    chat: value,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every test below but the device-support ones would otherwise land in
  // 'unsupported' before preload is reached at all. See the 'device support'
  // block for that path.
  vi.mocked(checkDeviceSupport).mockResolvedValue(SUPPORTED);
});

describe('usePreload', () => {
  it('starts in the checking phase', () => {
    vi.mocked(checkPreloaded).mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => usePreload(VOICE));

    expect(result.current.phase).toBe('checking');
    expect(result.current.isPreloading).toBe(false);
  });

  // Warm-up is the conversation's job, which builds one engine at a time
  // rather than all of them at once.
  it('moves to ready without warming anything up when everything is cached', async () => {
    const cached = status(true);
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(true);

    const { result } = renderHook(() => usePreload(VOICE));

    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.cached).toEqual(cached);
    expect(preloadAll).not.toHaveBeenCalled();
  });

  describe('persistent storage', () => {
    it('asks on mount when nothing is cached yet', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      expect(requestPersistentStorage).toHaveBeenCalledOnce();
    });

    it('asks on mount when everything is already cached', async () => {
      // A grant covers bytes already on disk, and returning visits are where
      // the browser's heuristics tend to say yes.
      vi.mocked(checkPreloaded).mockResolvedValue(status(true));
      vi.mocked(isFullyPreloaded).mockReturnValue(true);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('ready'));

      expect(requestPersistentStorage).toHaveBeenCalledOnce();
    });

    it('checks the cache without waiting on the answer', async () => {
      vi.mocked(requestPersistentStorage).mockReturnValueOnce(
        new Promise(() => {}),
      );
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));

      await waitFor(() => expect(result.current.phase).toBe('needed'));
    });

    it('does not ask on an unsupported device', async () => {
      vi.mocked(checkDeviceSupport).mockResolvedValue(UNSUPPORTED);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('unsupported'));

      expect(requestPersistentStorage).not.toHaveBeenCalled();
    });
  });

  it('moves to needed when some models are not cached, without warming up', async () => {
    const cached = status(true, {
      'speech-to-text': false,
      'text-to-speech': false,
    });
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(false);

    const { result } = renderHook(() => usePreload(VOICE));

    await waitFor(() => expect(result.current.phase).toBe('needed'));

    expect(result.current.cached).toEqual(cached);
    expect(preloadAll).not.toHaveBeenCalled();
  });

  it('moves to needed when only a wasm runtime is missing', async () => {
    // The models are all on disk, but the runtime one of them executes on
    // isn't — which used to slip past the check and surface as a silent
    // multi-megabyte download mid-conversation.
    const cached = status(true, { 'chat-runtime': false });
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(false);

    const { result } = renderHook(() => usePreload(VOICE));

    await waitFor(() => expect(result.current.phase).toBe('needed'));
    expect(preloadAll).not.toHaveBeenCalled();
  });

  it('sweeps stale downloads before checking what is cached', async () => {
    const order: string[] = [];
    vi.mocked(sweepStaleAssets).mockImplementationOnce(async () => {
      order.push('sweep');
      return 0;
    });
    vi.mocked(checkPreloaded).mockImplementationOnce(async () => {
      order.push('check');
      return status(false);
    });
    vi.mocked(isFullyPreloaded).mockReturnValue(false);

    const { result } = renderHook(() => usePreload(VOICE));

    await waitFor(() => expect(result.current.phase).toBe('needed'));
    expect(order).toEqual(['sweep', 'check']);
  });

  it('does not update state after unmount', async () => {
    let resolveCheck: (v: PreloadStatus) => void = () => {};
    vi.mocked(checkPreloaded).mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );

    const { result, unmount } = renderHook(() => usePreload(VOICE));
    unmount();
    resolveCheck(status(true));

    await Promise.resolve();
    await Promise.resolve();

    expect(result.current.phase).toBe('checking');
  });

  describe('a voice chosen after the first check', () => {
    it('re-checks what is cached for the new voice, leaving the phase alone', async () => {
      const otherCached = status(true, { 'text-to-speech': false });
      vi.mocked(checkPreloaded).mockImplementation(async (voice) =>
        voice === VOICE ? status(false) : otherCached,
      );
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result, rerender } = renderHook(
        ({ voice }) => usePreload(voice),
        { initialProps: { voice: VOICE } },
      );
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      rerender({ voice: OTHER_VOICE });

      await waitFor(() => expect(result.current.cached).toEqual(otherCached));
      expect(checkPreloaded).toHaveBeenLastCalledWith(OTHER_VOICE);
      expect(result.current.phase).toBe('needed');
    });

    it('does not check again until the voice changes', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result, rerender } = renderHook(
        ({ voice }) => usePreload(voice),
        { initialProps: { voice: VOICE } },
      );
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      rerender({ voice: VOICE });
      await Promise.resolve();

      expect(checkPreloaded).toHaveBeenCalledTimes(1);
    });

    it('downloads the voice chosen at the time Download is pressed', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockResolvedValue(undefined);

      const { result, rerender } = renderHook(
        ({ voice }) => usePreload(voice),
        { initialProps: { voice: VOICE } },
      );
      await waitFor(() => expect(result.current.phase).toBe('needed'));
      rerender({ voice: OTHER_VOICE });

      await act(async () => {
        await result.current.preload();
      });

      expect(preloadAll).toHaveBeenCalledWith(
        OTHER_VOICE,
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  describe('preload', () => {
    it('reports progress and marks everything cached on success', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.({ loaded: 500_000, total: 1_000_000, progress: 0.5 });
        return undefined;
      });

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      await act(async () => {
        await result.current.preload();
      });

      expect(result.current.isPreloading).toBe(false);
      expect(result.current.status).toBe('');
      expect(result.current.cached).toEqual(status(true));
      expect(result.current.phase).toBe('needed');
    });

    /**
     * Starts a download whose reports the test feeds by hand, held open until
     * the returned `finish` is called.
     */
    async function startDownload() {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const hook = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(hook.result.current.phase).toBe('needed'));

      let onProgress: Parameters<typeof preloadAll>[1];
      let onStepDone: Parameters<typeof preloadAll>[2];
      let finish: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, p, d) => {
        onProgress = p;
        onStepDone = d;
        return new Promise((resolve) => {
          finish = () => resolve(undefined);
        });
      });

      act(() => {
        void hook.result.current.preload();
      });
      await waitFor(() => expect(onProgress).toBeDefined());

      return {
        result: hook.result,
        report: (loaded: number, total: number) =>
          act(() => onProgress?.({ loaded, total, progress: loaded / total })),
        stepDone: (step: Parameters<NonNullable<typeof onStepDone>>[0]) =>
          act(() => onStepDone?.(step)),
        finish: () =>
          act(async () => {
            finish();
          }),
      };
    }

    it('reports one figure for the whole download', async () => {
      const download = await startDownload();

      download.report(250, 1000);

      expect(download.result.current.progress).toEqual({
        loaded: 250,
        total: 1000,
        percent: 25,
        isFinishing: false,
      });

      await download.finish();
    });

    it('never moves the bar backward', async () => {
      // A file's size arriving with its headers can raise the total mid-run.
      const download = await startDownload();

      download.report(500, 1000);
      download.report(500, 1250);

      expect(download.result.current.progress).toEqual(
        expect.objectContaining({ percent: 50, total: 1250 }),
      );

      await download.finish();
    });

    it('marks progress as finishing once every byte is in but the download has not resolved', async () => {
      const download = await startDownload();

      download.report(1000, 1000);

      expect(download.result.current.progress?.isFinishing).toBe(true);

      await download.finish();
    });

    it('ticks each step off as it finishes, before the rest are done', async () => {
      const download = await startDownload();

      download.stepDone('text-to-speech');

      expect(download.result.current.cached).toEqual(
        status(false, { 'text-to-speech': true }),
      );

      await download.finish();

      expect(download.result.current.cached).toEqual(status(true));
    });

    it('sets an error status and stops preloading on failure', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockRejectedValue(new Error('network error'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => usePreload(VOICE));
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

  describe('device support', () => {
    it('stops at unsupported without probing the cache when WebGPU is missing', async () => {
      vi.mocked(checkDeviceSupport).mockResolvedValue(UNSUPPORTED);

      const { result } = renderHook(() => usePreload(VOICE));

      await waitFor(() => expect(result.current.phase).toBe('unsupported'));
      expect(result.current.status).toBe('Device not supported');
      expect(result.current.support?.unmet.map((r) => r.id)).toEqual([
        'webgpu',
      ]);
      // The point of the gate: nothing is asked of storage, and nothing is
      // fetched.
      expect(sweepStaleAssets).not.toHaveBeenCalled();
      expect(checkPreloaded).not.toHaveBeenCalled();
      expect(preloadAll).not.toHaveBeenCalled();
    });

    it('never reaches ready on an unsupported device, even fully cached', async () => {
      // The case that crashed Safari: everything downloaded on a previous
      // visit, so the greeting starts the chat engine and throws on
      // navigator.gpu.requestAdapter.
      vi.mocked(checkDeviceSupport).mockResolvedValue(UNSUPPORTED);
      vi.mocked(checkPreloaded).mockResolvedValue(status(true));
      vi.mocked(isFullyPreloaded).mockReturnValue(true);

      const { result } = renderHook(() => usePreload(VOICE));

      await waitFor(() => expect(result.current.phase).toBe('unsupported'));
      expect(preloadAll).not.toHaveBeenCalled();
    });

    it('refuses to download when asked anyway', async () => {
      vi.mocked(checkDeviceSupport).mockResolvedValue(UNSUPPORTED);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('unsupported'));

      await act(async () => {
        await result.current.preload();
      });

      expect(preloadAll).not.toHaveBeenCalled();
      expect(requestPersistentStorage).not.toHaveBeenCalled();
      expect(result.current.isPreloading).toBe(false);
    });
  });

  describe('start', () => {
    it('moves the phase to ready', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      act(() => {
        result.current.start();
      });

      expect(result.current.phase).toBe('ready');
    });
  });
});
