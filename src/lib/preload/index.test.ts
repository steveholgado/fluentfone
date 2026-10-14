import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { hasStep, markStep, markWriteFailed } from '#/lib/cache/markers';
import { MODELS_CACHE } from '#/lib/cache/names';
import { EXPECTED_BYTES } from '#/lib/cache/rules';
import * as chat from '#/lib/chat';
import {
  bytesNeeded,
  checkPreloaded,
  isFullyPreloaded,
  isLabelPreloaded,
  isVoicePackCached,
  preloadAll,
  preloadVoicePack,
  voicePackBytes,
} from '#/lib/preload';
import type { PreloadStatus } from '#/lib/preload';
import { DOWNLOAD_ORDER } from '#/lib/preload/steps';
import * as speechToText from '#/lib/speech-to-text';
import * as textToSpeech from '#/lib/text-to-speech';
import { stubCacheStorage } from '#/test-utils';

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
let echo: BroadcastChannel | undefined;

async function report(message: AssetProgressMessage) {
  sw ??= new BroadcastChannel(PROGRESS_CHANNEL);
  // A second subscriber standing in for the one under test. Delivery is a
  // queued task per destination channel, in channel creation order, and
  // trackStep's channel is opened by runStep before the step's work calls in
  // here — so once this one has the message, that one has had it too.
  //
  // Waited on rather than a turn of the event loop, which was enough until the
  // suite grew busy enough to lose the race now and then. Timing out is not
  // the failure mode: runStep closes trackStep's channel the moment the step's
  // work resolves, so a message still in flight when report() returns is lost
  // rather than late, and no later assertion can recover it.
  echo ??= new BroadcastChannel(PROGRESS_CHANNEL);
  const receiver = echo;

  const delivered = new Promise<void>((resolve) => {
    receiver.addEventListener('message', () => resolve(), { once: true });
  });

  sw.postMessage(message);
  await delivered;
}

beforeEach(() => {
  // Reset rather than cleared: several tests below leave a step hanging on
  // purpose, and an implementation kept from one would hang the next.
  vi.resetAllMocks();
  vi.mocked(speechToText.preload).mockResolvedValue(undefined);
  vi.mocked(speechToText.isCached).mockResolvedValue(false);
  vi.mocked(chat.preload).mockResolvedValue(undefined);
  vi.mocked(chat.preloadRuntime).mockResolvedValue(undefined);
  vi.mocked(chat.isCached).mockResolvedValue(false);
  vi.mocked(chat.isRuntimeCached).mockResolvedValue(false);
  vi.mocked(textToSpeech.preload).mockResolvedValue(undefined);
  vi.mocked(textToSpeech.preloadRuntime).mockResolvedValue(undefined);
  vi.mocked(textToSpeech.isCached).mockResolvedValue(false);
  vi.mocked(textToSpeech.isRuntimeCached).mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sw?.close();
  echo?.close();
  sw = undefined;
  echo = undefined;
});

describe('preloadAll', () => {
  it('starts every step without waiting on the others', async () => {
    // Nothing here builds anything, so the only thing the steps share is
    // bandwidth: none of them should be held back behind another.
    const started: string[] = [];
    const never = () => new Promise<void>(() => {});

    vi.mocked(textToSpeech.preloadRuntime).mockImplementation(async () => {
      started.push('text-to-speech-runtime');
      await never();
    });
    vi.mocked(textToSpeech.preload).mockImplementation(async () => {
      started.push('text-to-speech');
      await never();
    });
    vi.mocked(speechToText.preload).mockImplementation(async () => {
      started.push('speech-to-text');
      await never();
    });
    vi.mocked(chat.preloadRuntime).mockImplementation(async () => {
      started.push('chat-runtime');
      await never();
    });
    vi.mocked(chat.preload).mockImplementation(async () => {
      started.push('chat');
      await never();
    });

    void preloadAll('en_US-hfc_female-medium');

    await vi.waitFor(() =>
      expect([...started].sort()).toEqual([...DOWNLOAD_ORDER].sort()),
    );
    expect(textToSpeech.preload).toHaveBeenCalledWith(
      'en_US-hfc_female-medium',
    );
  });

  it('sums reported bytes from every step into one figure', async () => {
    vi.mocked(chat.preload).mockImplementation(async () => {
      await report({
        step: 'chat',
        url: 'https://huggingface.co/litert-community/m.litertlm',
        loaded: 30,
        total: 100,
      });
    });
    vi.mocked(speechToText.preload).mockImplementation(async () => {
      await report({
        step: 'speech-to-text',
        url: 'https://huggingface.co/onnx-community/whisper/e.onnx',
        loaded: 20,
        total: 100,
      });
    });

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    // The denominator is the tracker's business; what matters here is that
    // both steps' bytes reached the same figure — on top of the three steps
    // that reported nothing, which count in full once they finish.
    const finishedSilently =
      EXPECTED_BYTES['text-to-speech-runtime'] +
      EXPECTED_BYTES['text-to-speech'] +
      EXPECTED_BYTES['chat-runtime'];
    const loaded = onProgress.mock.calls.map(([p]) => p.loaded);
    expect(loaded).toContain(finishedSilently + 50);
  });

  it('counts only what the check finds missing towards the total', async () => {
    // The same figure the preload screen quoted before the download began.
    vi.mocked(chat.isCached).mockResolvedValueOnce(true);
    vi.mocked(chat.isRuntimeCached).mockResolvedValueOnce(true);

    const onProgress = vi.fn();
    await preloadAll('voice-id', onProgress);

    expect(onProgress.mock.calls[0]?.[0]).toEqual({
      loaded: 0,
      total: bytesNeeded(status(false, { chat: true, 'chat-runtime': true })),
      progress: 0,
    });
  });

  it('opens at zero, so the bar shows before any bytes arrive', async () => {
    // A run served entirely from cache reports no bytes at all.
    const onProgress = vi.fn();

    await preloadAll('voice-id', onProgress);

    expect(onProgress.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ loaded: 0, progress: 0 }),
    );
  });

  it('lands on 100%, however little each step reported', async () => {
    // "Finishing up…" keys off this: the bytes are in, but the download has
    // not resolved yet.
    const onProgress = vi.fn();

    await preloadAll('voice-id', onProgress);

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1 }),
    );
  });

  it('says when each step finishes, as it does', async () => {
    let finishChat: () => void = () => {};
    vi.mocked(chat.preload).mockImplementation(
      () => new Promise<void>((resolve) => (finishChat = resolve)),
    );

    const onStepDone = vi.fn();
    const done = preloadAll('voice-id', undefined, onStepDone);

    await vi.waitFor(() => expect(onStepDone).toHaveBeenCalledTimes(4));
    expect(onStepDone).not.toHaveBeenCalledWith('chat');

    finishChat();
    await done;

    expect(onStepDone).toHaveBeenLastCalledWith('chat');
  });

  it('lets the other steps finish before rejecting with a failure', async () => {
    // Nothing should still be downloading behind a screen that says the
    // download failed, or a retry would fetch the same files twice.
    let finishChat: () => void = () => {};
    vi.mocked(chat.preload).mockImplementation(
      () => new Promise<void>((resolve) => (finishChat = resolve)),
    );
    vi.mocked(speechToText.preload).mockRejectedValueOnce(new Error('offline'));

    const onStepDone = vi.fn();
    let settled = false;
    const done = preloadAll('voice-id', undefined, onStepDone).finally(() => {
      settled = true;
    });
    done.catch(() => {});

    await vi.waitFor(() => expect(onStepDone).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);

    finishChat();

    await expect(done).rejects.toThrow('offline');
    expect(onStepDone).toHaveBeenCalledWith('chat');
    expect(onStepDone).not.toHaveBeenCalledWith('speech-to-text');
  });

  it('clears a write failure from an earlier run before the step works', async () => {
    // Otherwise a retry that stores everything would still read as not
    // downloaded — and one that fails again must be free to record it.
    stubCacheStorage();
    await markWriteFailed('chat');

    let failedDuringWork: boolean | undefined;
    vi.mocked(chat.preload).mockImplementation(async () => {
      const models = await caches.open(MODELS_CACHE);
      failedDuringWork =
        (await models.match('https://write-failed.invalid/chat')) !== undefined;
    });

    await preloadAll('voice-id');

    expect(failedDuringWork).toBe(false);
  });

  it('keeps a write failure recorded during the step', async () => {
    stubCacheStorage();
    await markStep('chat', 'model');
    vi.mocked(chat.preload).mockImplementation(async () => {
      await markWriteFailed('chat');
    });

    await preloadAll('voice-id');

    await expect(hasStep('chat', 'model')).resolves.toBe(false);
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

describe('bytesNeeded', () => {
  it('counts only the steps that are missing', () => {
    expect(bytesNeeded(status(true))).toBe(0);
    expect(bytesNeeded(status(true, { chat: false }))).toBe(
      EXPECTED_BYTES.chat,
    );
  });

  it('comes to the whole app when nothing is cached', () => {
    expect(bytesNeeded(status(false))).toBe(
      Object.values(EXPECTED_BYTES).reduce((sum, bytes) => sum + bytes, 0),
    );
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

describe('preloadVoicePack', () => {
  const PACK = ['es_MX-ald-medium', 'es_MX-claude-high'];

  it('downloads every voice in the pack, and nothing else', async () => {
    await preloadVoicePack(PACK);

    expect(
      vi.mocked(textToSpeech.preload).mock.calls.map(([id]) => id),
    ).toEqual(PACK);
    expect(textToSpeech.preloadRuntime).not.toHaveBeenCalled();
    expect(speechToText.preload).not.toHaveBeenCalled();
    expect(chat.preloadRuntime).not.toHaveBeenCalled();
    expect(chat.preload).not.toHaveBeenCalled();
  });

  it('runs once from zero to 100% for the whole pack', async () => {
    const onProgress = vi.fn();

    await preloadVoicePack(PACK, onProgress);

    expect(onProgress.mock.calls).toEqual([
      [{ loaded: 0, total: voicePackBytes(PACK), progress: 0 }],
      [
        {
          loaded: voicePackBytes(PACK),
          total: voicePackBytes(PACK),
          progress: 1,
        },
      ],
    ]);
  });

  it('sums the bytes of every voice in the pack', async () => {
    vi.mocked(textToSpeech.preload).mockImplementation(async (voiceId) => {
      await report({
        step: 'text-to-speech',
        url: `https://huggingface.co/diffusionstudio/piper-voices/${voiceId}.onnx`,
        loaded: 30,
        total: 100,
      });
    });

    const onProgress = vi.fn();
    await preloadVoicePack(PACK, onProgress);

    const loaded = onProgress.mock.calls.map(([p]) => p.loaded);
    expect(loaded).toContain(60);
  });

  it('fills the bar only once every voice is done', async () => {
    // Both voices are one step; the first to finish must not complete it.
    let finishSecond: () => void = () => {};
    vi.mocked(textToSpeech.preload).mockImplementation((voiceId) =>
      voiceId === PACK[1]
        ? new Promise<void>((resolve) => (finishSecond = resolve))
        : Promise.resolve(),
    );

    const onProgress = vi.fn();
    const done = preloadVoicePack(PACK, onProgress);

    await vi.waitFor(() =>
      expect(textToSpeech.preload).toHaveBeenCalledTimes(2),
    );
    await Promise.resolve();
    expect(onProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ progress: 1 }),
    );

    finishSecond();
    await done;

    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ progress: 1 }),
    );
  });

  it('rejects when a voice fails', async () => {
    vi.mocked(textToSpeech.preload).mockRejectedValueOnce(new Error('offline'));

    await expect(preloadVoicePack(PACK)).rejects.toThrow('offline');
  });
});

describe('isVoicePackCached', () => {
  it('is true only when every voice in the pack is on disk', async () => {
    vi.mocked(textToSpeech.isCached).mockImplementation(
      async (voiceId) => voiceId === 'a',
    );

    await expect(isVoicePackCached(['a'])).resolves.toBe(true);
    await expect(isVoicePackCached(['a', 'b'])).resolves.toBe(false);
  });

  it('treats a rejected check as not cached, without throwing', async () => {
    vi.mocked(textToSpeech.isCached).mockRejectedValue(
      new Error('no Cache Storage'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(isVoicePackCached(['a'])).resolves.toBe(false);

    warnSpy.mockRestore();
  });
});

describe('voicePackBytes', () => {
  it('counts one voice estimate per voice in the pack', () => {
    expect(voicePackBytes(['a'])).toBe(EXPECTED_BYTES['text-to-speech']);
    expect(voicePackBytes(['a', 'b'])).toBe(
      2 * EXPECTED_BYTES['text-to-speech'],
    );
  });
});
