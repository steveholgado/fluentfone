import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPreloaded, isFullyPreloaded, preloadAll } from '#/lib/preload';
import * as chat from '#/lib/chat';
import * as speechToText from '#/lib/speech-to-text';
import * as textToSpeech from '#/lib/text-to-speech';

vi.mock('#/lib/speech-to-text', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
}));
vi.mock('#/lib/chat', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
}));
vi.mock('#/lib/text-to-speech', () => ({
  preload: vi.fn().mockResolvedValue(undefined),
  isCached: vi.fn().mockResolvedValue(false),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('preloadAll', () => {
  it('preloads speech-to-text, chat, then text-to-speech in order', async () => {
    const order: string[] = [];

    vi.mocked(speechToText.preload).mockImplementation(async () => {
      order.push('speech-to-text');
    });
    vi.mocked(chat.preload).mockImplementation(async () => {
      order.push('chat');
      return {} as never;
    });
    vi.mocked(textToSpeech.preload).mockImplementation(async () => {
      order.push('text-to-speech');
    });

    await preloadAll('en_US-hfc_female-medium');

    expect(order).toEqual(['speech-to-text', 'chat', 'text-to-speech']);
    expect(textToSpeech.preload).toHaveBeenCalledWith(
      'en_US-hfc_female-medium',
      expect.any(Function),
    );
  });

  it('tags progress callbacks with the originating label', async () => {
    vi.mocked(speechToText.preload).mockImplementation(async (cb) => {
      cb?.({ loaded: 1 });
    });
    vi.mocked(chat.preload).mockImplementation(async (cb) => {
      cb?.({ loaded: 2 });
      return {} as never;
    });
    vi.mocked(textToSpeech.preload).mockImplementation(async (_v, cb) => {
      cb?.({ loaded: 3 });
    });

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    expect(onProgress).toHaveBeenCalledWith('speech-to-text', { loaded: 1 });
    expect(onProgress).toHaveBeenCalledWith('chat', { loaded: 2 });
    expect(onProgress).toHaveBeenCalledWith('text-to-speech', { loaded: 3 });
  });
});

describe('checkPreloaded', () => {
  it('reports each model keyed by label', async () => {
    vi.mocked(speechToText.isCached).mockResolvedValue(true);
    vi.mocked(chat.isCached).mockResolvedValue(false);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);

    const status = await checkPreloaded('voice-id');

    expect(status).toEqual({
      'speech-to-text': true,
      chat: false,
      'text-to-speech': true,
    });
    expect(textToSpeech.isCached).toHaveBeenCalledWith('voice-id');
  });

  it('treats a rejected cache check as not cached, without throwing', async () => {
    vi.mocked(speechToText.isCached).mockRejectedValue(new Error('no OPFS'));
    vi.mocked(chat.isCached).mockResolvedValue(true);
    vi.mocked(textToSpeech.isCached).mockResolvedValue(true);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const status = await checkPreloaded('voice-id');

    expect(status['speech-to-text']).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('isFullyPreloaded', () => {
  it('is true only when every model is cached', () => {
    expect(
      isFullyPreloaded({
        'speech-to-text': true,
        chat: true,
        'text-to-speech': true,
      }),
    ).toBe(true);

    expect(
      isFullyPreloaded({
        'speech-to-text': true,
        chat: false,
        'text-to-speech': true,
      }),
    ).toBe(false);
  });
});
