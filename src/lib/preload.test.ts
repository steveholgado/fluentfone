import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkPreloaded,
  isFullyPreloaded,
  isLabelPreloaded,
  preloadAll,
} from '#/lib/preload';
import type { PreloadStatus } from '#/lib/preload';
import {
  DOWNLOAD_ORDER,
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/assets';
import * as chat from '#/lib/chat';
import * as speechToText from '#/lib/speech-to-text';
import * as textToSpeech from '#/lib/text-to-speech';

vi.mock('#/lib/speech-to-text', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
}));
vi.mock('#/lib/chat', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  preloadRuntime: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
  isRuntimeCached: vi.fn().mockResolvedValue(false),
}));
vi.mock('#/lib/text-to-speech', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  preloadRuntime: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
  isRuntimeCached: vi.fn().mockResolvedValue(false),
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

/**
 * Stands in for the service worker. Delivery is asynchronous, so anything
 * posted has to be given a turn of the event loop to arrive.
 */
let sw: BroadcastChannel | undefined;

async function report(message: AssetProgressMessage) {
  sw ??= new BroadcastChannel(PROGRESS_CHANNEL);
  sw.postMessage(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  sw?.close();
  sw = undefined;
});

describe('preloadAll', () => {
  it('downloads each runtime immediately before the model that needs it, smallest capability first', async () => {
    const order: string[] = [];

    vi.mocked(textToSpeech.preloadRuntime).mockImplementation(async () => {
      order.push('text-to-speech-runtime');
    });
    vi.mocked(textToSpeech.preload).mockImplementation(async () => {
      order.push('text-to-speech');
    });
    vi.mocked(speechToText.preload).mockImplementation(async () => {
      order.push('speech-to-text');
    });
    vi.mocked(chat.preloadRuntime).mockImplementation(async () => {
      order.push('chat-runtime');
    });
    vi.mocked(chat.preload).mockImplementation(async () => {
      order.push('chat');
    });

    await preloadAll('en_US-hfc_female-medium');

    // Speech-to-text is one step, not two: its wasm runtime cannot be
    // downloaded without also building the pipeline.
    expect(order).toEqual([
      'text-to-speech-runtime',
      'text-to-speech',
      'speech-to-text',
      'chat-runtime',
      'chat',
    ]);
    expect(textToSpeech.preload).toHaveBeenCalledWith(
      'en_US-hfc_female-medium',
    );
  });

  it('attributes reported bytes to whichever step is running', async () => {
    // The worker says only what it is streaming; running one step at a time is
    // what makes those bytes attributable to a step at all.
    vi.mocked(chat.preload).mockImplementation(async () => {
      await report({
        step: 'chat',
        url: 'https://huggingface.co/litert-community/m.litertlm',
        loaded: 30,
        total: 100,
      });
    });

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    // The denominator is the step's business (asset-progress owns the floor);
    // what matters here is that the bytes were attributed to 'chat' at all.
    expect(onProgress).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ loaded: 30 }),
    );
  });

  it('ignores bytes belonging to a step that is not running', async () => {
    // A late report from the previous step would otherwise land on this one's
    // bar, which only moves forward and so could never recover.
    vi.mocked(chat.preloadRuntime).mockImplementation(async () => {
      await report({
        step: 'chat',
        url: 'https://huggingface.co/litert-community/m.litertlm',
        loaded: 30,
        total: 100,
      });
    });

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    expect(onProgress).not.toHaveBeenCalledWith(
      'chat-runtime',
      expect.objectContaining({ loaded: 30 }),
    );
  });

  it('opens every step at zero, so a silent one cannot inherit the last full bar', async () => {
    // A step that reports no bytes — served from cache, or downloading
    // somewhere the worker cannot see — otherwise never touches the UI at all,
    // leaving the previous step's terminal 100% on screen as "Finishing up…"
    // for as long as it runs.
    const onProgress = vi.fn();

    await preloadAll('voice-id', onProgress);

    for (const step of DOWNLOAD_ORDER) {
      const first = onProgress.mock.calls.find(
        ([reported]) => reported === step,
      );
      expect(first?.[1]).toEqual({ loaded: 0, total: 1, progress: 0 });
    }
  });

  it('lands every step on 100%, however little it reported', async () => {
    // "Finishing up…" keys off this: the bytes are in, but the step is still
    // compiling or writing to disk. A step served entirely from cache reports
    // nothing at all and goes straight here.
    const onProgress = vi.fn();

    await preloadAll('voice-id', onProgress);

    for (const step of [
      'text-to-speech-runtime',
      'text-to-speech',
      'speech-to-text',
      'chat-runtime',
      'chat',
    ]) {
      expect(onProgress).toHaveBeenCalledWith(step, {
        loaded: 1,
        total: 1,
        progress: 1,
      });
    }
  });
});

describe('checkPreloaded', () => {
  it('reports each download keyed by step', async () => {
    vi.mocked(speechToText.isCached).mockResolvedValue(true);
    vi.mocked(chat.isCached).mockResolvedValue(false);
    vi.mocked(chat.isRuntimeCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isRuntimeCached).mockResolvedValue(false);

    const result = await checkPreloaded('voice-id');

    expect(result).toEqual({
      'text-to-speech-runtime': false,
      'text-to-speech': true,
      'speech-to-text': true,
      'chat-runtime': true,
      chat: false,
    });
    expect(textToSpeech.isCached).toHaveBeenCalledWith('voice-id');
  });

  it('reports a missing runtime even when its model is fully downloaded', async () => {
    // The case that used to escape the check entirely: the chat model is on
    // disk, so the preload screen was skipped, and Engine.create() then
    // fetched tens of megabytes of wasm during the conversation.
    vi.mocked(speechToText.isCached).mockResolvedValue(true);
    vi.mocked(chat.isCached).mockResolvedValue(true);
    vi.mocked(chat.isRuntimeCached).mockResolvedValue(false);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isRuntimeCached).mockResolvedValue(true);

    const result = await checkPreloaded('voice-id');

    expect(result['chat-runtime']).toBe(false);
    expect(isFullyPreloaded(result)).toBe(false);
  });

  it('treats a rejected cache check as not cached, without throwing', async () => {
    vi.mocked(speechToText.isCached).mockRejectedValue(new Error('no storage'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await checkPreloaded('voice-id');

    expect(result['speech-to-text']).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('isFullyPreloaded', () => {
  it('is true only when every step is cached', () => {
    expect(isFullyPreloaded(status(true))).toBe(true);
    expect(isFullyPreloaded(status(true, { chat: false }))).toBe(false);
    expect(isFullyPreloaded(status(true, { 'chat-runtime': false }))).toBe(
      false,
    );
  });
});

describe('isLabelPreloaded', () => {
  it('is true only when both the runtime and the model behind a label are cached', () => {
    expect(isLabelPreloaded(status(true), 'chat')).toBe(true);
    expect(isLabelPreloaded(status(true, { chat: false }), 'chat')).toBe(false);
    expect(
      isLabelPreloaded(status(true, { 'chat-runtime': false }), 'chat'),
    ).toBe(false);
  });

  it('does not let one label’s missing step affect another', () => {
    const partial = status(true, { 'chat-runtime': false });

    expect(isLabelPreloaded(partial, 'speech-to-text')).toBe(true);
    expect(isLabelPreloaded(partial, 'text-to-speech')).toBe(true);
    expect(isLabelPreloaded(partial, 'chat')).toBe(false);
  });
});
