import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

import { stubCacheStorage } from '#/test-utils';
import { DEFAULT_CHAT_MODEL } from '#/lib/chat/constants';
import type { ChatRequest, WorkerResponse } from '#/lib/chat/messages';

const sendMessageStreaming = vi.fn();
const createConversation = vi.fn();
const engineCreate = vi.fn();
const engineDelete = vi.fn();

const getOrLoadGlobalLiteRtLm = vi.fn();

vi.mock('@litert-lm/core', () => ({
  Backend: { GPU_ARTISAN: 2 },
  Engine: { create: (...args: unknown[]) => engineCreate(...args) },
  LiteRtLm: { DEFAULT_WASM_PATH: 'https://cdn.example/@litert-lm/core/wasm' },
  getOrLoadGlobalLiteRtLm: () => getOrLoadGlobalLiteRtLm(),
}));

/** A reply as the SDK streams it: one message per chunk, new text only. */
function streamOf(...chunks: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

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

const chunks = () =>
  postedMessages
    .filter(
      (m): m is Extract<WorkerResponse, { type: 'chunk' }> =>
        m.type === 'chunk',
    )
    .map((m) => m.text);

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
  createConversation.mockResolvedValue({ sendMessageStreaming });
  sendMessageStreaming.mockImplementation(() => streamOf('a reply'));
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
    expect(sendMessageStreaming).toHaveBeenCalledWith({
      role: 'user',
      content: 'hi there',
    });
  });

  it('sends an empty trigger message when no prompt is given', async () => {
    await post(generateRequest({ systemInstruction: 'open with a greeting' }));

    expect(sendMessageStreaming).toHaveBeenCalledWith({
      role: 'user',
      content: '',
    });
  });

  it('sends the trigger in place of a prompt', async () => {
    await post(generateRequest({ trigger: 'greet the student' }));

    expect(sendMessageStreaming).toHaveBeenCalledWith({
      role: 'user',
      content: 'greet the student',
    });
  });

  it('sends the prompt, not the trigger, when given both', async () => {
    await post(generateRequest({ prompt: 'hola', trigger: 'greet' }));

    expect(sendMessageStreaming).toHaveBeenCalledWith({
      role: 'user',
      content: 'hola',
    });
  });

  it('posts each chunk as it arrives, then the whole reply', async () => {
    sendMessageStreaming.mockImplementation(() =>
      streamOf(
        { content: [{ type: 'text', text: 'Me gusta. ' }] },
        { content: [{ type: 'text', text: '¿Y a ti?' }] },
      ),
    );

    await post(generateRequest({ prompt: 'hi' }));

    expect(chunks()).toEqual(['Me gusta. ', '¿Y a ti?']);
    expect(replies()).toEqual([
      { id: 0, type: 'done', text: 'Me gusta. ¿Y a ti?' },
    ]);
    // Chunks come before the reply that ends the request.
    expect(postedMessages.at(-1)?.type).toBe('done');
  });

  it('extracts text from each chunk’s shape', async () => {
    sendMessageStreaming.mockImplementation(() =>
      streamOf(
        { text: 'plain text field ' },
        { content: [{ text: 'part one ' }, { text: 'part two' }] },
      ),
    );

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([
      { id: 0, type: 'done', text: 'plain text field part one part two' },
    ]);
  });

  it('skips chunks that carry no text', async () => {
    sendMessageStreaming.mockImplementation(() =>
      streamOf({ content: [] }, 'Hola'),
    );

    await post(generateRequest({ prompt: 'hi' }));

    expect(chunks()).toEqual(['Hola']);
  });

  it('passes the resolved sampler params through as a top-p session config', async () => {
    // index.ts merges them over the defaults before posting; nothing on this
    // side has a second copy of those defaults to disagree with. They go under
    // `sessionConfig`, in the library's own names — at the top level, as they
    // once were, the library ignored them.
    await post(
      generateRequest({
        prompt: 'hi',
        samplerParams: {
          temperature: 0.1,
          topK: 40,
          topP: 0.95,
          randomSeed: 7,
        },
      }),
    );

    const config = createConversation.mock.calls[0][0];
    expect(config.sessionConfig).toEqual({
      samplerParams: { type: 2, k: 40, p: 0.95, temperature: 0.1, seed: 7 },
    });
    expect(config).not.toHaveProperty('samplerParams');
  });

  it('draws a fresh seed for each conversation that isn’t given one', async () => {
    // The engine's default seed is fixed, so without this every conversation
    // would sample the same way — the same greeting on every visit.
    vi.spyOn(crypto, 'getRandomValues')
      .mockImplementationOnce((array) => {
        (array as Uint32Array)[0] = 10;
        return array;
      })
      .mockImplementationOnce((array) => {
        (array as Uint32Array)[0] = 0xffffffff;
        return array;
      });

    await post(generateRequest({ prompt: 'hi' }));
    await post(generateRequest({ prompt: 'unrelated' }));

    const seeds = createConversation.mock.calls.map(
      ([config]) => config.sessionConfig.samplerParams.seed,
    );
    // 31 bits, to fit the engine's signed int.
    expect(seeds).toEqual([5, 0x7fffffff]);
  });

  it('keeps reusing a conversation whose seed was drawn for it', async () => {
    await post(generateRequest({ prompt: 'hi' }));
    await post(
      generateRequest({
        prompt: 'next',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'model', content: 'a reply' },
        ],
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('creates the engine able to sample from more than the top token', async () => {
    // GPU_ARTISAN's max_top_k defaults to 1, and a sampler asking for more
    // fails outright — "Top-K value 40 must be <= 1".
    const { MAX_TOP_K } = await import('#/lib/chat/constants');

    await post(generateRequest({ prompt: 'hi' }));

    expect(engineCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 2,
        mainExecutorSettings: expect.objectContaining({
          maxNumTokens: 8192,
          backendConfig: expect.objectContaining({ max_top_k: MAX_TOP_K }),
        }),
      }),
    );
  });

  it('keeps the default top-K within what the engine allows', async () => {
    const { DEFAULT_SAMPLER_PARAMS, MAX_TOP_K } =
      await import('#/lib/chat/constants');

    expect(DEFAULT_SAMPLER_PARAMS.topK).toBeLessThanOrEqual(MAX_TOP_K);
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

  it('posts an error message when generation fails mid-stream', async () => {
    sendMessageStreaming.mockImplementation(
      () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue('Hola');
            controller.error(new Error('boom'));
          },
        }),
    );

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([{ id: 0, type: 'error', message: 'boom' }]);
  });

  it('deletes the conversation even when generation fails', async () => {
    const conversationDelete = vi.fn();
    createConversation.mockResolvedValue({
      sendMessageStreaming: () =>
        new ReadableStream({
          start(controller) {
            controller.error(new Error('boom'));
          },
        }),
      delete: conversationDelete,
    });

    await post(generateRequest({ prompt: 'hi' }));

    expect(conversationDelete).toHaveBeenCalled();
  });

  it('stringifies non-Error throwables', async () => {
    engineCreate.mockRejectedValue('plain string failure');

    await post(generateRequest({ prompt: 'hi' }));

    expect(replies()).toEqual([
      { id: 0, type: 'error', message: 'plain string failure' },
    ]);
  });
});

describe('conversation reuse', () => {
  /** A conversation of its own per createConversation call, to tell them apart. */
  function distinctConversations() {
    const made: Array<{ delete: ReturnType<typeof vi.fn> }> = [];
    createConversation.mockImplementation(async () => {
      const conversation = { sendMessageStreaming, delete: vi.fn() };
      made.push(conversation);
      return conversation;
    });
    return made;
  }

  it('sends only the new message when the history is what the conversation holds', async () => {
    await post(generateRequest({ prompt: 'hi' }));
    await post(
      generateRequest({
        prompt: 'next',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'model', content: 'a reply' },
        ],
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls).toEqual([
      [{ role: 'user', content: 'hi' }],
      [{ role: 'user', content: 'next' }],
    ]);
  });

  it('carries on from an opening message, whose trigger isn’t in the history', async () => {
    await post(generateRequest({ systemInstruction: 'greet' }));
    await post(
      generateRequest({
        systemInstruction: 'greet',
        prompt: 'hola',
        history: [{ role: 'model', content: 'a reply' }],
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
  });

  it('carries on from an opening message sent with a trigger', async () => {
    await post(
      generateRequest({ systemInstruction: 'chat', trigger: 'greet' }),
    );
    await post(
      generateRequest({
        systemInstruction: 'chat',
        prompt: 'hola',
        history: [{ role: 'model', content: 'a reply' }],
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(sendMessageStreaming.mock.calls).toEqual([
      [{ role: 'user', content: 'greet' }],
      [{ role: 'user', content: 'hola' }],
    ]);
  });

  it('builds afresh, and deletes the old one, when the history differs', async () => {
    const made = distinctConversations();

    await post(generateRequest({ prompt: 'hi' }));
    await post(
      generateRequest({
        prompt: 'next',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'model', content: 'something else' },
        ],
      }),
    );

    expect(made).toHaveLength(2);
    expect(made[0].delete).toHaveBeenCalled();
    expect(createConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preface: {
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'model', content: 'something else' },
          ],
        },
      }),
    );
  });

  it('builds afresh when the settings change', async () => {
    await post(generateRequest({ prompt: 'hi', systemInstruction: 'a' }));
    await post(
      generateRequest({
        prompt: 'next',
        systemInstruction: 'b',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'model', content: 'a reply' },
        ],
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(2);
  });

  it('does not keep a conversation whose generation failed', async () => {
    const made = distinctConversations();
    sendMessageStreaming.mockImplementationOnce(
      () =>
        new ReadableStream({
          start(controller) {
            controller.error(new Error('boom'));
          },
        }),
    );

    await post(generateRequest({ prompt: 'hi' }));
    await post(generateRequest({ prompt: 'hi' }));

    expect(made).toHaveLength(2);
    expect(made[0].delete).toHaveBeenCalled();
  });

  it('keeps the conversation after a turn, rather than deleting it', async () => {
    const made = distinctConversations();

    await post(generateRequest({ prompt: 'hi' }));

    expect(made[0].delete).not.toHaveBeenCalled();
  });

  it('deletes the kept conversation on dispose, before the engines', async () => {
    const made = distinctConversations();
    const order: string[] = [];
    engineDelete.mockImplementation(() => order.push('engine'));

    await post(generateRequest({ prompt: 'hi' }));
    made[0].delete.mockImplementation(() => order.push('conversation'));
    await post({ mode: 'dispose' });

    expect(order).toEqual(['conversation', 'engine']);
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
