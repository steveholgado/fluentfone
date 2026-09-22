import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

import { stubCacheStorage } from '#/test-utils';
import { DEFAULT_CHAT_MODEL } from '#/lib/chat/constants';
import type { ChatRequest, WorkerResponse } from '#/lib/chat/messages';

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

let postedMessages: WorkerResponse[] = [];
let onmessage:
  | ((event: MessageEvent<ChatRequest & { id: number }>) => Promise<void>)
  | undefined;

let nextId = 0;

/** Posts one request into the worker and resolves when it has answered. */
function post(request: ChatRequest) {
  return onmessage?.({ data: { ...request, id: nextId++ } } as MessageEvent<
    ChatRequest & { id: number }
  >);
}

/** A generate request with every default already resolved, as index.ts sends. */
function generateRequest(
  overrides: Partial<Extract<ChatRequest, { mode: 'generate' }>> = {},
): ChatRequest {
  return {
    mode: 'generate',
    history: [],
    modelUrl: DEFAULT_CHAT_MODEL,
    maxNumTokens: 8192,
    samplerParams: { temperature: 0.8, topK: 40, topP: 0.95 },
    ...overrides,
  };
}

const stages = () =>
  postedMessages
    .filter(
      (m): m is Extract<WorkerResponse, { type: 'stage' }> =>
        m.type === 'stage',
    )
    .map((m) => m.stage);

const replies = () =>
  postedMessages.filter((m) => m.type === 'done' || m.type === 'error');

beforeEach(async () => {
  vi.clearAllMocks();
  postedMessages = [];
  nextId = 0;
  stubCacheStorage();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
  );
  vi.stubGlobal('self', {
    postMessage: (msg: WorkerResponse) => postedMessages.push(msg),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });

  getOrLoadGlobalLiteRtLm.mockResolvedValue(undefined);
  createConversation.mockResolvedValue({ sendMessage });
  sendMessage.mockResolvedValue('a reply');
  engineCreate.mockResolvedValue({
    createConversation,
    delete: engineDelete,
  });

  await import('#/lib/chat/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('generate', () => {
  it('creates a conversation with the system instruction and history as preface', async () => {
    await post(
      generateRequest({
        prompt: 'hi there',
        systemInstruction: 'be nice',
        history: [
          { role: 'user', content: 'earlier' },
          { role: 'model', content: 'earlier reply' },
        ],
      }),
    );

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
    await post(generateRequest({ systemInstruction: 'open with a greeting' }));

    expect(sendMessage).toHaveBeenCalledWith({ role: 'user', content: '' });
  });

  it('posts the extracted text back against the request id', async () => {
    sendMessage.mockResolvedValue({ text: 'plain text field' });

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([
      { id: 0, type: 'done', text: 'plain text field' },
    ]);
  });

  it('extracts text from a content-parts array response', async () => {
    sendMessage.mockResolvedValue({
      content: [{ text: 'part one ' }, { text: 'part two' }],
    });

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([
      { id: 0, type: 'done', text: 'part one part two' },
    ]);
  });

  it('passes the resolved sampler params straight through', async () => {
    // index.ts merges them over the defaults before posting; nothing on this
    // side has a second copy of those defaults to disagree with.
    await post(
      generateRequest({
        prompt: 'hi',
        samplerParams: { temperature: 0.1, topK: 40, topP: 0.95 },
      }),
    );

    expect(createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        samplerParams: { temperature: 0.1, topK: 40, topP: 0.95 },
      }),
    );
  });

  it('deletes the conversation after use when supported', async () => {
    const conversationDelete = vi.fn();
    createConversation.mockResolvedValue({
      sendMessage,
      delete: conversationDelete,
    });

    await post(generateRequest({ prompt: 'hi' }));

    expect(conversationDelete).toHaveBeenCalled();
  });

  it('reuses the same engine for repeated calls with the same model/context size', async () => {
    await post(generateRequest({ prompt: 'first' }));
    await post(generateRequest({ prompt: 'second' }));

    expect(engineCreate).toHaveBeenCalledTimes(1);
  });

  it('creates a distinct engine for a different maxNumTokens', async () => {
    await post(generateRequest({ prompt: 'first', maxNumTokens: 4096 }));
    await post(generateRequest({ prompt: 'second', maxNumTokens: 8192 }));

    expect(engineCreate).toHaveBeenCalledTimes(2);
  });

  it('posts an error message when generation throws', async () => {
    sendMessage.mockRejectedValue(new Error('boom'));

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([{ id: 0, type: 'error', message: 'boom' }]);
  });

  it('stringifies non-Error throwables', async () => {
    engineCreate.mockRejectedValue('plain string failure');

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([
      { id: 0, type: 'error', message: 'plain string failure' },
    ]);
  });
});

describe('stage reporting', () => {
  it('reports downloading, then compiling, then generating', async () => {
    // Engine.create() loads the wasm runtime, sets up a WebGPU device and
    // compiles the model, reporting nothing throughout — so this is the only
    // signal the UI has to distinguish that work from a hang.
    await post(generateRequest({ prompt: 'hi' }));

    expect(stages()).toEqual(['downloading', 'compiling', 'generating']);
  });

  it('reports loading, not downloading, when the bytes are already on disk', async () => {
    // fetchModel cannot tell the two apart — both are a fetch the service
    // worker answers — so on every return visit a multi-gigabyte disk read was
    // being announced as a fresh download.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    await post(generateRequest({ prompt: 'hi' }));

    expect(stages()).toEqual(['loading', 'compiling', 'generating']);
  });

  it('skips straight to generating once the engine is live', async () => {
    await post(generateRequest({ prompt: 'first' }));
    postedMessages = [];

    await post(generateRequest({ prompt: 'second' }));

    expect(stages()).toEqual(['generating']);
  });

  it('tags every stage with the request it belongs to', async () => {
    // Two conversations can be in flight at once; the main thread routes
    // stages back to an onStage callback by id and must not cross them.
    await post(generateRequest({ prompt: 'first' }));

    expect(postedMessages.every((m) => m.id === 0)).toBe(true);
  });
});

describe('preload', () => {
  it('pulls the model file down and marks the step, without warming up the engine', async () => {
    const { hasStep } = await import('#/lib/cache/markers');

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('litertlm'));
    expect(engineCreate).not.toHaveBeenCalled();
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
    expect(replies()).toEqual([{ id: 0, type: 'done' }]);
  });

  it('does no work when the bytes are already cached', async () => {
    // Getting them on disk is all this step does — unlike the other preload
    // steps it warms nothing up. Running anyway meant every return visit
    // streamed the whole model out of the cache and discarded it, against the
    // same disk the greeting was waiting on to read that very file.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks the step when it finds the bytes already cached', async () => {
    // Bytes present with no marker is what an interrupted run leaves behind,
    // and the marker is what the preload screen reads.
    const { MODELS_CACHE } = await import('#/lib/cache/names');
    const { hasStep } = await import('#/lib/cache/markers');
    const cache = await caches.open(MODELS_CACHE);
    await cache.put(DEFAULT_CHAT_MODEL, new Response('weights'));

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
  });

  it('downloads on the word of the cache, not of the marker', async () => {
    // A marker outlives a failed cache write, so trusting it here would skip
    // the download for bytes that are not there.
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('chat', DEFAULT_CHAT_MODEL);

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('litertlm'));
  });

  it('does not hold the model in memory for the session', async () => {
    // It is gigabytes. The service worker has the bytes, so Engine.create()
    // re-reads them from there rather than this keeping a Blob alive.
    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });
    await post(generateRequest({ prompt: 'hi' }));

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

    const { hasStep } = await import('#/lib/cache/markers');

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(replies()).toEqual([{ id: 0, type: 'done' }]);
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(true);
  });

  it('does not mark the step if the download fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const { hasStep } = await import('#/lib/cache/markers');

    await post({ mode: 'preload', modelUrl: DEFAULT_CHAT_MODEL });

    expect(replies()).toEqual([
      {
        id: 0,
        type: 'error',
        message: expect.stringContaining('Failed to download model'),
      },
    ]);
    await expect(hasStep('chat', DEFAULT_CHAT_MODEL)).resolves.toBe(false);
  });
});

describe('preload-runtime', () => {
  it('lets the library load its own wasm, then marks the step', async () => {
    const { hasStep } = await import('#/lib/cache/markers');

    await post({ mode: 'preload-runtime' });

    // We no longer reproduce LiteRT-LM's four-way build selection to fetch
    // the file ourselves — the library picks, and the service worker
    // recognises whichever one it asks for.
    expect(getOrLoadGlobalLiteRtLm).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    // Loading the runtime must not drag the model compile along with it;
    // that stays where it was, in the generate request.
    expect(engineCreate).not.toHaveBeenCalled();
    await expect(hasStep('chat-runtime', LITERT_VERSION)).resolves.toBe(true);
  });

  it('does not cache a failure, so a later attempt can retry', async () => {
    getOrLoadGlobalLiteRtLm.mockRejectedValue(new Error('wasm unavailable'));

    await post({ mode: 'preload-runtime' });
    await post({ mode: 'preload-runtime' });

    expect(getOrLoadGlobalLiteRtLm).toHaveBeenCalledTimes(2);
    expect(replies()).toEqual([
      { id: 0, type: 'error', message: 'wasm unavailable' },
      { id: 1, type: 'error', message: 'wasm unavailable' },
    ]);
  });
});

describe('dispose', () => {
  it('deletes every cached engine', async () => {
    await post(generateRequest({ prompt: 'hi' }));
    await post({ mode: 'dispose' });

    expect(engineDelete).toHaveBeenCalled();
  });

  it('leaves the next generate to build a fresh engine', async () => {
    await post(generateRequest({ prompt: 'hi' }));
    await post({ mode: 'dispose' });
    await post(generateRequest({ prompt: 'again' }));

    expect(engineCreate).toHaveBeenCalledTimes(2);
  });
});
