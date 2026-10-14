import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import { trackDownload, trackStep } from '#/lib/preload/track';

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
const CHAT = EXPECTED_BYTES.chat;

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
    // The voice's 5 KB config finishes long before the 63 MB model fetched
    // alongside it. Without the estimate the config would complete at
    // 4817/4817 — 100% — and the bar, which never moves backwards, would sit
    // there for the whole model.
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

    const observed = EXPECTED_BYTES['chat-runtime'] * 2;
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

  it('falls back to the estimate when no response declares a length', async () => {
    const onProgress = vi.fn();
    stop = trackStep('chat', onProgress);

    await report({ step: 'chat', url: 'a', loaded: 10, total: null });

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 10,
      total: CHAT,
      progress: 10 / CHAT,
    });
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

describe('trackDownload', () => {
  it('sums every step it is given into one figure', async () => {
    const onProgress = vi.fn();
    stop = trackDownload(
      { chat: 1000, 'speech-to-text': 1000 },
      onProgress,
    ).stop;

    await report(
      { step: 'chat', url: 'a', loaded: 300, total: 1000 },
      { step: 'speech-to-text', url: 'b', loaded: 200, total: 1000 },
    );

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 500,
      total: 2000,
      progress: 0.25,
    });
  });

  it('holds each step to its own estimate, not a pooled one', async () => {
    // A file that came in larger than its step's estimate raises that step's
    // share alone; another step's unspent estimate can't absorb it.
    const onProgress = vi.fn();
    stop = trackDownload(
      { chat: 1000, 'speech-to-text': 1000 },
      onProgress,
    ).stop;

    await report({ step: 'chat', url: 'a', loaded: 0, total: 1500 });

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ total: 2500 }),
    );
  });

  it('ignores bytes from steps it was not given', async () => {
    const onProgress = vi.fn();
    stop = trackDownload({ chat: 1000 }, onProgress).stop;

    await report({ step: 'chat-runtime', url: 'a', loaded: 10, total: 100 });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('counts a zero-estimate step only once its bytes turn up', async () => {
    // A step the check called cached, whose bytes turned out to be missing.
    const onProgress = vi.fn();
    stop = trackDownload({ chat: 0, 'speech-to-text': 1000 }, onProgress).stop;

    await report({ step: 'chat', url: 'a', loaded: 100, total: 1000 });

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 100,
      total: 2000,
      progress: 0.05,
    });
  });

  it('fills a completed step whatever it reported', async () => {
    // A step served from cache reports nothing; one that came in under its
    // estimate reports less than it. Either would leave the bar short.
    const onProgress = vi.fn();
    const tracker = trackDownload(
      { chat: 1000, 'speech-to-text': 1000 },
      onProgress,
    );
    stop = tracker.stop;

    await report({ step: 'chat', url: 'a', loaded: 600, total: 600 });
    tracker.complete('chat');
    tracker.complete('speech-to-text');

    expect(onProgress).toHaveBeenLastCalledWith({
      loaded: 2000,
      total: 2000,
      progress: 1,
    });
  });

  it('says nothing until something happens', () => {
    // openVoice tracks its voice on every open, and after a preload nothing
    // is downloaded at all.
    const onProgress = vi.fn();
    stop = trackDownload({ chat: 1000 }, onProgress).stop;

    expect(onProgress).not.toHaveBeenCalled();
  });
});
