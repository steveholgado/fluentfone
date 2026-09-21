import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

import { stubCacheStorage } from '#/test-utils';

const sendMessage = vi.fn();
const createConversation = vi.fn();
const engineCreate = vi.fn();
const engineDelete = vi.fn();

const getOrLoadGlobalLiteRtLm = vi.fn();

vi.mock('@litert-lm/core', () => ({
  Engine: { create: (...args: unknown[]) => engineCreate(...args) },
  LiteRtLm: { DEFAULT_WASM_PATH: 'https://cdn.example/@litert-lm/core/wasm' },
  getOrLoadGlobalLiteRtLm: () => getOrLoadGlobalLiteRtLm(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  stubCacheStorage();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );

  getOrLoadGlobalLiteRtLm.mockResolvedValue(undefined);
  createConversation.mockResolvedValue({ sendMessage });
  sendMessage.mockResolvedValue('a reply');
  engineCreate.mockResolvedValue({
    createConversation,
    delete: engineDelete,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('generateMessage', () => {
  it('creates a conversation with the system instruction and history as preface', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({
      prompt: 'hi there',
      systemInstruction: 'be nice',
      history: [
        { role: 'user', content: 'earlier' },
        { role: 'model', content: 'earlier reply' },
      ],
    });

    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        preface: {
          messages: [
            { role: 'system', content: 'be nice' },
            { role: 'user', content: 'earlier' },
            { role: 'model', content: 'earlier reply' },
          ],
        },
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      role: 'user',
      content: 'hi there',
    });
  });

  it('sends an empty trigger message when no prompt is given', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ systemInstruction: 'open with a greeting' });

    expect(sendMessage).toHaveBeenCalledWith({ role: 'user', content: '' });
  });

  it('returns the extracted text response', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    sendMessage.mockResolvedValue({ text: 'plain text field' });

    await expect(generateMessage({ prompt: 'hi' })).resolves.toBe(
      'plain text field',
    );
  });

  it('extracts text from a content-parts array response', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    sendMessage.mockResolvedValue({
      content: [{ text: 'part one ' }, { text: 'part two' }],
    });

    await expect(generateMessage({ prompt: 'hi' })).resolves.toBe(
      'part one part two',
    );
  });

  it('merges custom sampler params over the defaults', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({
      prompt: 'hi',
      samplerParams: { temperature: 0.1 },
    });

    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        samplerParams: expect.objectContaining({
          temperature: 0.1,
          topK: 40,
          topP: 0.95,
        }),
      }),
    );
  });

  it('deletes the conversation after use when supported', async () => {
    const conversationDelete = vi.fn();
    createConversation.mockResolvedValue({
      sendMessage,
      delete: conversationDelete,
    });

    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'hi' });

    expect(conversationDelete).toHaveBeenCalled();
  });

  it('reuses the same engine for repeated calls with the same model/context size', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'first' });
    await generateMessage({ prompt: 'second' });

    expect(engineCreate).toHaveBeenCalledTimes(1);
  });

  it('creates a distinct engine for a different maxNumTokens', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'first', maxNumTokens: 4096 });
    await generateMessage({ prompt: 'second', maxNumTokens: 8192 });

    expect(engineCreate).toHaveBeenCalledTimes(2);
  });
});

describe('onStage', () => {
  it('reports downloading, then compiling, then generating', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    const stages: string[] = [];

    await generateMessage({ prompt: 'hi', onStage: (s) => stages.push(s) });

    // Engine.create() loads the wasm runtime, sets up a WebGPU device and
    // compiles the model, reporting nothing throughout — so this is the only
    // signal the UI has to distinguish that work from a hang.
    expect(stages).toEqual(['downloading', 'compiling', 'generating']);
  });

  it('reports loading, not downloading, when the bytes are already on disk', async () => {
    // fetchModel cannot tell the two apart — both are a fetch the worker
    // answers — so on every return visit a multi-gigabyte disk read was being
    // announced as a fresh download.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    const { generateMessage } = await import('#/lib/chat/index');
    const stages: string[] = [];

    await generateMessage({ prompt: 'hi', onStage: (s) => stages.push(s) });

    expect(stages).toEqual(['loading', 'compiling', 'generating']);
  });

  it('skips straight to generating once the engine is live', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'first' });

    const stages: string[] = [];
    await generateMessage({ prompt: 'second', onStage: (s) => stages.push(s) });

    expect(stages).toEqual(['generating']);
  });
});

describe('preload', () => {
  it('pulls the model file down and marks the step, without warming up the engine', async () => {
    const { preload } = await import('#/lib/chat/index');
    const { hasStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');

    await preload();

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('litertlm'));
    expect(engineCreate).not.toHaveBeenCalled();
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
  });

  it('does no work when the bytes are already cached', async () => {
    // Getting them on disk is all this step does — unlike the other preload
    // steps it warms nothing up. Running anyway meant every return visit
    // streamed the whole model out of the cache and discarded it, against the
    // same disk the greeting was waiting on to read that very file.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    const { preload } = await import('#/lib/chat/index');

    await preload();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks the step when it finds the bytes already cached', async () => {
    // Bytes present with no marker is what an interrupted run leaves behind,
    // and the marker is what the preload screen reads.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    const { hasStep } = await import('#/lib/cache/markers');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    const { preload } = await import('#/lib/chat/index');

    await preload();

    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
  });

  it('downloads on the word of the cache, not of the marker', async () => {
    // A marker outlives a failed cache write, so trusting it here would skip
    // the download for bytes that are not there.
    const { markStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    await markStep('chat', DEFAULT_CHAT_MODEL);

    const { preload } = await import('#/lib/chat/index');

    await preload();

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('litertlm'));
  });

  it('does not hold the model in memory for the session', async () => {
    // It is gigabytes. The service worker has the bytes, so Engine.create()
    // re-reads them from there rather than this keeping a Blob alive.
    const { preload, generateMessage } = await import('#/lib/chat/index');

    await preload();
    await generateMessage({ prompt: 'hi' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(engineCreate).toHaveBeenCalledTimes(1);
  });

  it('streams the model past rather than buffering it whole', async () => {
    // The file is ~3 GB. Reading it into an ArrayBuffer needs one contiguous
    // allocation that size, which fails often enough that the step would
    // reject *after* a successful download — leaving the marker unwritten and
    // the screen still offering the download.
    const arrayBuffer = vi.fn(async () => {
      throw new RangeError('Array buffer allocation failed');
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response(new Uint8Array([1, 2, 3]));
        Object.defineProperty(response, 'arrayBuffer', { value: arrayBuffer });
        return response;
      }),
    );

    const { preload } = await import('#/lib/chat/index');
    const { hasStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');

    await expect(preload()).resolves.toBeUndefined();

    expect(arrayBuffer).not.toHaveBeenCalled();
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
  });

  it('does not mark the step if the download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const { preload } = await import('#/lib/chat/index');
    const { hasStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');

    await expect(preload()).rejects.toThrow('Failed to download model');
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(false);
  });
});

describe('preloadRuntime', () => {
  it('lets the library load its own wasm, then marks the step', async () => {
    const { preloadRuntime } = await import('#/lib/chat/index');
    const { hasStep } = await import('#/lib/cache/markers');

    await preloadRuntime();

    // We no longer reproduce LiteRT-LM's four-way build selection to fetch
    // the file ourselves — the library picks, and the service worker
    // recognises whichever one it asks for.
    expect(getOrLoadGlobalLiteRtLm).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    // Loading the runtime must not drag the model compile along with it;
    // that stays where it was, in generateMessage().
    expect(engineCreate).not.toHaveBeenCalled();
    await expect(hasStep('chat-runtime', LITERT_VERSION)).resolves.toBe(true);
  });

  it('does not cache a failure, so a later attempt can retry', async () => {
    getOrLoadGlobalLiteRtLm.mockRejectedValue(new Error('wasm unavailable'));

    const { preloadRuntime } = await import('#/lib/chat/index');

    await expect(preloadRuntime()).rejects.toThrow();
    await expect(preloadRuntime()).rejects.toThrow();
    expect(getOrLoadGlobalLiteRtLm).toHaveBeenCalledTimes(2);
  });
});

describe('isRuntimeCached', () => {
  it('is true immediately once the runtime has loaded in this session', async () => {
    const { preloadRuntime, isRuntimeCached } =
      await import('#/lib/chat/index');

    await preloadRuntime();

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('is true when the step marker is present', async () => {
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('chat-runtime', LITERT_VERSION);

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('does not match a marker left by a different package version', async () => {
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('chat-runtime', '0.0.1-ancient');

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('does not import the library to answer', async () => {
    // Runs during the check stage, so it must not pull in 20 MB of wasm to
    // say whether that wasm is present.
    const { isRuntimeCached } = await import('#/lib/chat/index');

    await isRuntimeCached();

    expect(getOrLoadGlobalLiteRtLm).not.toHaveBeenCalled();
  });

  it('is false when nothing is loaded and there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(false);
  });
});

describe('isCached', () => {
  it('is true immediately once an engine has been created in this session', async () => {
    const { generateMessage, isCached } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'hi' });

    await expect(isCached()).resolves.toBe(true);
  });

  it('falls back to the step marker when nothing is live', async () => {
    const { markStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    const { isCached } = await import('#/lib/chat/index');
    await markStep('chat', DEFAULT_CHAT_MODEL);

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not match a marker left by a different model', async () => {
    // Switching between the e2b and e4b builds has to miss, or the preload
    // screen would be skipped for a model that was never downloaded.
    const { markStep } = await import('#/lib/cache/markers');
    const { CHAT_MODELS } = await import('#/lib/chat/constants');
    const { isCached } = await import('#/lib/chat/index');
    await markStep('chat', CHAT_MODELS.e2b);

    await expect(isCached(CHAT_MODELS.e4b)).resolves.toBe(false);
  });
});

describe('dispose', () => {
  it('deletes every cached engine', async () => {
    const { generateMessage, dispose } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'hi' });
    await dispose();

    expect(engineDelete).toHaveBeenCalled();
  });
});
