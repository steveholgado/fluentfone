import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkPreloaded,
  isFullyPreloaded,
  isLabelPreloaded,
  preloadAll,
} from '#/lib/preload';
import type { PreloadStatus } from '#/lib/preload';
import * as chat from '#/lib/chat';
import * as speechToText from '#/lib/speech-to-text';
import * as textToSpeech from '#/lib/text-to-speech';

vi.mock('#/lib/speech-to-text', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  preloadRuntime: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
  isRuntimeCached: vi.fn().mockResolvedValue(false),
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
    'speech-to-text-runtime': value,
    'speech-to-text': value,
    'chat-runtime': value,
    chat: value,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.mocked(speechToText.preloadRuntime).mockImplementation(async () => {
      order.push('speech-to-text-runtime');
    });
    vi.mocked(speechToText.preload).mockImplementation(async () => {
      order.push('speech-to-text');
    });
    vi.mocked(chat.preloadRuntime).mockImplementation(async () => {
      order.push('chat-runtime');
    });
    vi.mocked(chat.preload).mockImplementation(async () => {
      order.push('chat');
      return {} as never;
    });

    await preloadAll('en_US-hfc_female-medium');

    expect(order).toEqual([
      'text-to-speech-runtime',
      'text-to-speech',
      'speech-to-text-runtime',
      'speech-to-text',
      'chat-runtime',
      'chat',
    ]);
    expect(textToSpeech.preload).toHaveBeenCalledWith(
      'en_US-hfc_female-medium',
      expect.any(Function),
    );
  });

  it('tags progress callbacks with the originating step', async () => {
    vi.mocked(speechToText.preload).mockImplementation(async (cb) => {
      cb?.({ loaded: 1 });
    });
    vi.mocked(speechToText.preloadRuntime).mockImplementation(async (cb) => {
      cb?.({ loaded: 10 });
    });
    vi.mocked(chat.preload).mockImplementation(async (cb) => {
      cb?.({ loaded: 2 });
      return {} as never;
    });
    vi.mocked(chat.preloadRuntime).mockImplementation(async (cb) => {
      cb?.({ loaded: 20 });
    });
    vi.mocked(textToSpeech.preload).mockImplementation(async (_v, cb) => {
      cb?.({ loaded: 3 });
    });
    vi.mocked(textToSpeech.preloadRuntime).mockImplementation(async (cb) => {
      cb?.({ loaded: 30 });
    });

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    expect(onProgress).toHaveBeenCalledWith('speech-to-text', { loaded: 1 });
    expect(onProgress).toHaveBeenCalledWith('chat', { loaded: 2 });
    expect(onProgress).toHaveBeenCalledWith('text-to-speech', { loaded: 3 });
    expect(onProgress).toHaveBeenCalledWith('speech-to-text-runtime', {
      loaded: 10,
    });
    expect(onProgress).toHaveBeenCalledWith('chat-runtime', { loaded: 20 });
    expect(onProgress).toHaveBeenCalledWith('text-to-speech-runtime', {
      loaded: 30,
    });
  });
});

describe('checkPreloaded', () => {
  it('reports each download keyed by step', async () => {
    vi.mocked(speechToText.isCached).mockResolvedValue(true);
    vi.mocked(speechToText.isRuntimeCached).mockResolvedValue(true);
    vi.mocked(chat.isCached).mockResolvedValue(false);
    vi.mocked(chat.isRuntimeCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isRuntimeCached).mockResolvedValue(false);

    const result = await checkPreloaded('voice-id');

    expect(result).toEqual({
      'text-to-speech-runtime': false,
      'text-to-speech': true,
      'speech-to-text-runtime': true,
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
    vi.mocked(speechToText.isRuntimeCached).mockResolvedValue(true);
    vi.mocked(chat.isCached).mockResolvedValue(true);
    vi.mocked(chat.isRuntimeCached).mockResolvedValue(false);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isRuntimeCached).mockResolvedValue(true);

    const result = await checkPreloaded('voice-id');

    expect(result['chat-runtime']).toBe(false);
    expect(isFullyPreloaded(result)).toBe(false);
  });

  it('treats a rejected cache check as not cached, without throwing', async () => {
    vi.mocked(speechToText.isCached).mockRejectedValue(new Error('no OPFS'));
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
