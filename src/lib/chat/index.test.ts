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

vi.mock('@litert-lm/core', () => ({
  Engine: { create: (...args: unknown[]) => engineCreate(...args) },
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

describe('preload', () => {
  it('warms up the engine and forwards download progress', async () => {
    const { preload } = await import('#/lib/chat/index');
    const onProgress = vi.fn();

    await preload(onProgress);

    expect(modelCache.fetchModelAsBlob).toHaveBeenCalledWith(
      expect.stringContaining('litertlm'),
      onProgress,
    );
  });
});

describe('isCached', () => {
  it('is true immediately once an engine has been created in this session', async () => {
    const { preload, isCached } = await import('#/lib/chat/index');

    await preload();

    await expect(isCached()).resolves.toBe(true);
    expect(modelCache.hasCachedModel).not.toHaveBeenCalled();
  });

  it('falls back to checking the model cache when no engine is live', async () => {
    vi.mocked(modelCache.hasCachedModel).mockResolvedValue(true);
    const { isCached } = await import('#/lib/chat/index');

    await expect(isCached()).resolves.toBe(true);
    expect(modelCache.hasCachedModel).toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('deletes every cached engine and clears the cache', async () => {
    const { preload, dispose, isCached } = await import('#/lib/chat/index');

    await preload();
    await dispose();

    expect(engineDelete).toHaveBeenCalled();
    vi.mocked(modelCache.hasCachedModel).mockResolvedValue(false);
    await expect(isCached()).resolves.toBe(false);
  });
});
