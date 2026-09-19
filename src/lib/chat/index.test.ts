import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as modelCache from '#/lib/chat/model-cache';

vi.mock('#/lib/chat/model-cache', () => ({
  fetchModelAsBlob: vi.fn(),
  hasCachedModel: vi.fn(),
  clearModelCache: vi.fn(),
}));

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
  vi.mocked(modelCache.fetchModelAsBlob).mockResolvedValue(new Blob(['x']));

  createConversation.mockResolvedValue({ sendMessage });
  sendMessage.mockResolvedValue('a reply');
  engineCreate.mockResolvedValue({
    createConversation,
    delete: engineDelete,
  });
});

afterEach(() => {
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

  it('skips straight to generating once the engine is live', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'first' });

    const stages: string[] = [];
    await generateMessage({ prompt: 'second', onStage: (s) => stages.push(s) });

    expect(stages).toEqual(['generating']);
  });
});

describe('preload', () => {
  it('downloads the model file and forwards progress, without warming up the engine', async () => {
    const { preload } = await import('#/lib/chat/index');
    const onProgress = vi.fn();

    await preload(onProgress);

    expect(modelCache.fetchModelAsBlob).toHaveBeenCalledWith(
      expect.stringContaining('litertlm'),
      onProgress,
    );
    expect(engineCreate).not.toHaveBeenCalled();
  });

  it('lets a later generateMessage() reuse the already-downloaded blob', async () => {
    const { preload, generateMessage } = await import('#/lib/chat/index');

    await preload();
    await generateMessage({ prompt: 'hi' });

    expect(modelCache.fetchModelAsBlob).toHaveBeenCalledTimes(1);
    expect(engineCreate).toHaveBeenCalledTimes(1);
  });
});

describe('preloadRuntime', () => {
  it('downloads both runtime files and then instantiates the module', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Length': '3' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', undefined);

    const { preloadRuntime } = await import('#/lib/chat/index');
    await preloadRuntime();

    // The glue script and its wasm — the pair Engine.create() would
    // otherwise fetch mid-conversation with no progress reported.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getOrLoadGlobalLiteRtLm).toHaveBeenCalled();
    // Downloading the runtime must not drag the model compile along with it;
    // that stays where it was, in generateMessage().
    expect(engineCreate).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not cache a failure, so a later attempt can retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    vi.stubGlobal('caches', undefined);

    const { preloadRuntime } = await import('#/lib/chat/index');

    await expect(preloadRuntime()).rejects.toThrow();
    await expect(preloadRuntime()).rejects.toThrow();

    vi.unstubAllGlobals();
  });
});

describe('isRuntimeCached', () => {
  it('is true immediately once the runtime has been warmed in this session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'Content-Length': '1' },
          }),
      ),
    );
    vi.stubGlobal('caches', undefined);

    const { preloadRuntime, isRuntimeCached } =
      await import('#/lib/chat/index');

    await preloadRuntime();

    await expect(isRuntimeCached()).resolves.toBe(true);

    vi.unstubAllGlobals();
  });

  it('is false when nothing is warmed and there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('isCached', () => {
  it('is true immediately once the model file has been downloaded in this session', async () => {
    const { preload, isCached } = await import('#/lib/chat/index');

    await preload();

    await expect(isCached()).resolves.toBe(true);
    expect(modelCache.hasCachedModel).not.toHaveBeenCalled();
  });

  it('is true immediately once an engine has been created in this session', async () => {
    const { generateMessage, isCached } = await import('#/lib/chat/index');

    await generateMessage({ prompt: 'hi' });

    await expect(isCached()).resolves.toBe(true);
    expect(modelCache.hasCachedModel).not.toHaveBeenCalled();
  });

  it('falls back to checking the model cache when nothing is live', async () => {
    vi.mocked(modelCache.hasCachedModel).mockResolvedValue(true);
    const { isCached } = await import('#/lib/chat/index');

    await expect(isCached()).resolves.toBe(true);
    expect(modelCache.hasCachedModel).toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('deletes every cached engine and clears the cache', async () => {
    const { generateMessage, dispose, isCached } =
      await import('#/lib/chat/index');

    await generateMessage({ prompt: 'hi' });
    await dispose();

    expect(engineDelete).toHaveBeenCalled();
    vi.mocked(modelCache.hasCachedModel).mockResolvedValue(false);
    await expect(isCached()).resolves.toBe(false);
  });
});
