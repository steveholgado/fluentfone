import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackStep } from '#/lib/preload/track';
import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { EXPECTED_BYTES } from '#/lib/cache/rules';

/** Stands in for the service worker. Delivery is asynchronous. */
let sw: BroadcastChannel | undefined;
let stop: (() => void) | undefined;

async function report(...messages: AssetProgressMessage[]) {
  sw ??= new BroadcastChannel(PROGRESS_CHANNEL);
  for (const message of messages) sw.postMessage(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  stop?.();
  stop = undefined;
  sw?.close();
  sw = undefined;
});

/**
 * The step's own estimate, which is the floor every denominator below is
 * measured against — fixtures smaller than it would simply be overridden by
 * it, and would be testing the floor rather than the summing.
 */
const CHAT = EXPECTED_BYTES.chat!;

describe('trackStep', () => {
  it('reports a single file against its declared size', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report({ step: 'chat', url: 'a', loaded: CHAT / 4, total: CHAT });

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: CHAT / 4,
      total: CHAT,
      progress: 0.25,
    });
  });

  it('sums across the files a step downloads together', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report(
      { step: 'chat', url: 'a', loaded: CHAT / 10, total: CHAT },
      { step: 'chat', url: 'b', loaded: (CHAT / 10) * 4, total: CHAT },
    );

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: CHAT / 2,
      total: CHAT * 2,
      progress: 0.25,
    });
  });

  it('replaces a file’s earlier figure rather than adding to it', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report(
      { step: 'chat', url: 'a', loaded: CHAT / 10, total: CHAT },
      { step: 'chat', url: 'a', loaded: (CHAT / 10) * 6, total: CHAT },
    );

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: (CHAT / 10) * 6,
      total: CHAT,
      progress: 0.6,
    });
  });

  it('ignores bytes belonging to another step', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report({ step: 'chat-runtime', url: 'a', loaded: 10, total: 100 });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('starts from the estimate so the denominator cannot grow mid-step', async () => {
    // The worker only learns a file's size when its headers arrive. Summing
    // sizes as files joined would let the total grow, and since the bar never
    // moves backwards it would strand at whatever peak it hit while the total
    // was still short.
    const expected = EXPECTED_BYTES['chat-runtime'];
    expect(expected).toBeDefined();

    const onProgress = vi.fn();
    stop = trackStep('chat-runtime', onProgress);

    // The small file of the pair lands first and completes.
    await report({
      step: 'chat-runtime',
      url: 'litertlm_wasm_internal.js',
      loaded: 291_938,
      total: 291_938,
    });

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 291_938,
      total: expected,
      progress: 291_938 / expected!,
    });
  });

  it('survives the voice download’s tiny-file-first ordering', async () => {
    // TtsSession.create fetches the 5 KB voice config, awaits it, and only
    // then fetches the 63 MB model. Without the estimate the first file would
    // complete at 5033/5033 — 100% — and the bar, which never moves
    // backwards, would sit there for the whole model.
    const onProgress = vi.fn();
    stop = trackStep('text-to-speech', onProgress);

    await report({
      step: 'text-to-speech',
      url: 'es_ES-davefx-medium.onnx.json',
      loaded: 4817,
      total: 4817,
    });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: expect.closeTo(0, 3) }),
    );

    await report({
      step: 'text-to-speech',
      url: 'es_ES-davefx-medium.onnx',
      loaded: 63_201_294,
      total: 63_201_294,
    });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1 }),
    );
  });

  it('believes observation over a stale estimate', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat-runtime', onProgress);

    const observed = EXPECTED_BYTES['chat-runtime']! * 2;
    await report({
      step: 'chat-runtime',
      url: 'a',
      loaded: 0,
      total: observed,
    });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ total: observed }),
    );
  });

  it('never reports beyond 100%, even if the files overshoot', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report({ step: 'chat', url: 'a', loaded: CHAT * 1.5, total: CHAT });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1 }),
    );
  });

  it('reports an unknown total rather than one the bar would overrun', async () => {
    // Every step carries an estimate today, so the entry is removed for the
    // duration: this guards the case of one added later without, where no
    // Content-Length leaves no denominator at all. Reporting "unknown" is what
    // keeps the bar from being handed a number it would run past.
    const estimate = EXPECTED_BYTES.chat;
    delete EXPECTED_BYTES.chat;

    try {
      const onProgress = vi.fn();
      stop = trackStep('chat', onProgress);

      await report({ step: 'chat', url: 'a', loaded: 10, total: null });

      expect(onProgress).toHaveBeenLastCalledWith({
        loaded: 10,
        total: undefined,
        progress: undefined,
      });
    } finally {
      EXPECTED_BYTES.chat = estimate;
    }
  });

  it('stops reporting once the step is over', async () => {
    const onProgress = vi.fn();
    const end = trackStep('chat', onProgress);
    end();

    await report({ step: 'chat', url: 'a', loaded: 10, total: 100 });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('is a no-op without a progress callback', () => {
    // preloadAll runs steps for their side effects during the silent
    // background warm-up too.
    expect(() => trackStep('chat')()).not.toThrow();
  });
});
