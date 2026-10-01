import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePreload } from '#/hooks/usePreload';
import { checkDeviceSupport, type DeviceSupport } from '#/lib/device';
import { checkPreloaded, isFullyPreloaded, preloadAll } from '#/lib/preload';
import type { PreloadStatus } from '#/lib/preload';
import { requestPersistentStorage } from '#/lib/persist';
import { sweepStaleAssets } from '#/lib/preload/sweep';

vi.mock('#/lib/persist', () => ({
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

  it('moves to ready and warms up in the background when everything is cached', async () => {
    const cached = status(true);
    vi.mocked(checkPreloaded).mockResolvedValue(cached);
    vi.mocked(isFullyPreloaded).mockReturnValue(true);
    vi.mocked(preloadAll).mockResolvedValue(undefined);

    const { result } = renderHook(() => usePreload(VOICE));

    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.cached).toEqual(cached);
    expect(preloadAll).toHaveBeenCalledWith(VOICE);
  });

  it('logs but does not throw when the background warm-up fails', async () => {
    vi.mocked(checkPreloaded).mockResolvedValue(status(true));
    vi.mocked(isFullyPreloaded).mockReturnValue(true);
    vi.mocked(preloadAll).mockRejectedValue(new Error('warm-up failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => usePreload(VOICE));

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
      );
    });
  });

  describe('preload', () => {
    it('reports progress and marks everything cached on success', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('speech-to-text', {
          loaded: 500_000,
          total: 1_000_000,
          progress: 0.5,
        });
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

    it('gives every step a slot, including ones the check called cached', async () => {
      // preloadAll runs all five whatever the check found, so a step whose
      // marker claims it is on disk while the bytes are not still downloads in
      // full. Dropping its reports for want of a slot is what left the bar
      // frozen on the previous step's 100% for the length of that download.
      vi.mocked(checkPreloaded).mockResolvedValue(
        status(true, { chat: false }),
      );
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      let resolvePreloadAll: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('text-to-speech', { loaded: 1, total: 1, progress: 1 });
        onProgress?.('speech-to-text', { loaded: 1, total: 1, progress: 1 });
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
          index: 5,
          total: 5,
          percent: 50,
          isFinishing: false,
        }),
      );

      await act(async () => {
        resolvePreloadAll();
      });
    });

    it('gives a runtime download its own step, so the bar does not stick', async () => {
      // The runtime and the model it feeds are separate steps precisely so
      // that each gets a full 0→100 sweep. Reported as one step, the second
      // download would be clamped behind the first one's peak.
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      let resolvePreloadAll: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('text-to-speech-runtime', {
          loaded: 1,
          total: 1,
          progress: 1,
        });
        onProgress?.('text-to-speech', {
          loaded: 250_000,
          total: 1_000_000,
          progress: 0.25,
        });
        return new Promise((resolve) => {
          resolvePreloadAll = () => resolve(undefined);
        });
      });

      act(() => {
        void result.current.preload();
      });

      // Step 2 of 5, back down at 25% — not pinned at the runtime's 100%.
      await waitFor(() =>
        expect(result.current.progress).toEqual({
          index: 2,
          total: 5,
          percent: 25,
          isFinishing: false,
        }),
      );

      await act(async () => {
        resolvePreloadAll();
      });
    });

    it('marks progress as finishing once a step hits 100% but preloadAll has not moved past it', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      let resolvePreloadAll: () => void = () => {};
      vi.mocked(preloadAll).mockImplementation(async (_voice, onProgress) => {
        onProgress?.('text-to-speech-runtime', {
          loaded: 1,
          total: 1,
          progress: 1,
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
          total: 5,
          percent: 100,
          isFinishing: true,
        }),
      );

      await act(async () => {
        resolvePreloadAll();
      });
    });

    it('asks for persistent storage when the download starts, not on mount', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockResolvedValue(undefined);

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      // Firefox prompts for it, so it waits for the click that agrees to the
      // download.
      expect(requestPersistentStorage).not.toHaveBeenCalled();

      await act(async () => {
        await result.current.preload();
      });

      expect(requestPersistentStorage).toHaveBeenCalledOnce();
    });

    it('downloads without waiting on the persistent storage answer', async () => {
      vi.mocked(checkPreloaded).mockResolvedValue(status(false));
      vi.mocked(isFullyPreloaded).mockReturnValue(false);
      vi.mocked(preloadAll).mockResolvedValue(undefined);
      // A Firefox prompt the user never answers.
      vi.mocked(requestPersistentStorage).mockReturnValueOnce(
        new Promise(() => {}),
      );

      const { result } = renderHook(() => usePreload(VOICE));
      await waitFor(() => expect(result.current.phase).toBe('needed'));

      await act(async () => {
        await result.current.preload();
      });

      expect(preloadAll).toHaveBeenCalled();
      expect(result.current.cached).toEqual(status(true));
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
