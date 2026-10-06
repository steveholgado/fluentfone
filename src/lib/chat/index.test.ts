import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

import { stubCacheStorage } from '#/test-utils';
import type { WorkerRequest, WorkerResponse } from '#/lib/chat/messages';

// What the engine does with a request is worker.test.ts' business. This file
// covers the main thread's half: resolving defaults before anything is posted,
// routing replies and stages back to the right caller, and answering the
// "already cached?" questions without spawning a worker at all.

class FakeWorker {
  static instances: FakeWorker[] = [];

  listeners: Record<string, ((event: unknown) => void)[]> = {};
  terminate = vi.fn();
  postedMessages: WorkerRequest[] = [];

  constructor(
    public url: URL,
    public options?: { type: string },
  ) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  postMessage(message: WorkerRequest) {
    this.postedMessages.push(message);
  }

  emit(response: WorkerResponse) {
    for (const listener of this.listeners.message ?? []) {
      listener({ data: response } as MessageEvent<WorkerResponse>);
    }
  }

  emitError(err: unknown) {
    for (const listener of this.listeners.error ?? []) {
      listener(err);
    }
  }
}

/** The worker is created synchronously inside send(), so this is always ready. */
const only = () => FakeWorker.instances[0];

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('caches', undefined);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('generateMessage', () => {
  it('posts the prompt, system instruction and history to the worker', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const promise = generateMessage({
      prompt: 'hi there',
      systemInstruction: 'be nice',
      history: [{ role: 'user', content: 'earlier' }],
    });
    only().emit({ id: 0, type: 'done', text: 'a reply' });

    await expect(promise).resolves.toBe('a reply');
    expect(only().postedMessages[0]).toEqual(
      expect.objectContaining({
        id: 0,
        mode: 'generate',
        prompt: 'hi there',
        systemInstruction: 'be nice',
        history: [{ role: 'user', content: 'earlier' }],
      }),
    );
  });

  it('posts the trigger for an opening message', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const promise = generateMessage({
      systemInstruction: 'be nice',
      trigger: 'greet the student',
    });
    only().emit({ id: 0, type: 'done', text: '¡Hola!' });
    await promise;

    expect(only().postedMessages[0]).toEqual(
      expect.objectContaining({
        prompt: undefined,
        trigger: 'greet the student',
        history: [],
      }),
    );
  });

  it('resolves the model, context size and sampler defaults before posting', async () => {
    // The worker has no second copy of these, so anything left undefined here
    // would reach the engine as undefined.
    const { generateMessage } = await import('#/lib/chat/index');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');

    const promise = generateMessage({ prompt: 'hi' });
    only().emit({ id: 0, type: 'done', text: '' });
    await promise;

    expect(only().postedMessages[0]).toEqual(
      expect.objectContaining({
        modelUrl: DEFAULT_CHAT_MODEL,
        maxNumTokens: 4096,
        samplerParams: { temperature: 0.8, topK: 40, topP: 0.95 },
      }),
    );
  });

  it('merges custom sampler params over the defaults', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const promise = generateMessage({
      prompt: 'hi',
      samplerParams: { temperature: 0.1 },
    });
    only().emit({ id: 0, type: 'done', text: '' });
    await promise;

    expect(only().postedMessages[0]).toEqual(
      expect.objectContaining({
        samplerParams: { temperature: 0.1, topK: 40, topP: 0.95 },
      }),
    );
  });

  it('reports stages to onStage as they arrive', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    const stages: string[] = [];

    const promise = generateMessage({
      prompt: 'hi',
      onStage: (stage) => stages.push(stage),
    });
    only().emit({ id: 0, type: 'stage', stage: 'loading' });
    only().emit({ id: 0, type: 'stage', stage: 'generating' });
    only().emit({ id: 0, type: 'done', text: 'done' });
    await promise;

    expect(stages).toEqual(['loading', 'generating']);
  });

  it('passes each chunk to onChunk, and still resolves with the whole reply', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    const chunks: string[] = [];

    const promise = generateMessage({
      prompt: 'hi',
      onChunk: (text) => chunks.push(text),
    });
    only().emit({ id: 0, type: 'chunk', text: 'Me gusta. ' });
    only().emit({ id: 0, type: 'chunk', text: '¿Y a ti?' });
    only().emit({ id: 0, type: 'done', text: 'Me gusta. ¿Y a ti?' });

    await expect(promise).resolves.toBe('Me gusta. ¿Y a ti?');
    expect(chunks).toEqual(['Me gusta. ', '¿Y a ti?']);
  });

  it('keeps callbacks out of the worker request', async () => {
    // A function can't be structured-cloned; posting one would throw.
    const { generateMessage } = await import('#/lib/chat/index');

    void generateMessage({ prompt: 'hi', onStage: vi.fn(), onChunk: vi.fn() });

    expect(only().postedMessages[0]).not.toHaveProperty('onStage');
    expect(only().postedMessages[0]).not.toHaveProperty('onChunk');
  });

  it('rejects when the worker reports an error', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const promise = generateMessage({ prompt: 'hi' });
    only().emit({ id: 0, type: 'error', message: 'generation failed' });

    await expect(promise).rejects.toThrow('generation failed');
  });

  it('rejects everything in flight when the worker itself fails', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const first = generateMessage({ prompt: 'a' });
    const second = generateMessage({ prompt: 'b' });
    only().emitError(new Error('worker died'));

    await expect(first).rejects.toThrow('worker died');
    await expect(second).rejects.toThrow('worker died');
  });

  it('keeps overlapping calls and their stages apart', async () => {
    const { generateMessage } = await import('#/lib/chat/index');
    const firstStages: string[] = [];
    const secondStages: string[] = [];

    const first = generateMessage({
      prompt: 'a',
      onStage: (s) => firstStages.push(s),
    });
    const second = generateMessage({
      prompt: 'b',
      onStage: (s) => secondStages.push(s),
    });

    expect(only().postedMessages.map((m) => m.id)).toEqual([0, 1]);

    only().emit({ id: 1, type: 'stage', stage: 'generating' });
    // Resolve out of order to prove results aren't mixed up.
    only().emit({ id: 1, type: 'done', text: 'second' });
    only().emit({ id: 0, type: 'done', text: 'first' });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(firstStages).toEqual([]);
    expect(secondStages).toEqual(['generating']);
  });

  it('reuses a single worker across calls, so the engine stays warm', async () => {
    const { generateMessage } = await import('#/lib/chat/index');

    const first = generateMessage({ prompt: 'a' });
    only().emit({ id: 0, type: 'done', text: '' });
    await first;

    const second = generateMessage({ prompt: 'b' });
    only().emit({ id: 1, type: 'done', text: '' });
    await second;

    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe('preload', () => {
  it('asks the worker for the model, so the main thread never drains it', async () => {
    const { preload } = await import('#/lib/chat/index');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');

    const promise = preload();
    only().emit({ id: 0, type: 'done' });
    await promise;

    expect(only().postedMessages[0]).toEqual({
      id: 0,
      mode: 'preload',
      modelUrl: DEFAULT_CHAT_MODEL,
    });
  });
});

describe('preloadRuntime', () => {
  it('asks the worker to load the wasm runtime', async () => {
    const { preloadRuntime } = await import('#/lib/chat/index');

    const promise = preloadRuntime();
    only().emit({ id: 0, type: 'done' });
    await promise;

    expect(only().postedMessages[0]).toEqual({
      id: 0,
      mode: 'preload-runtime',
    });
  });
});

describe('isRuntimeCached', () => {
  it('is true immediately once the runtime has loaded in this session', async () => {
    const { preloadRuntime, isRuntimeCached } =
      await import('#/lib/chat/index');

    const promise = preloadRuntime();
    only().emit({ id: 0, type: 'done' });
    await promise;

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('is true when the step marker is present', async () => {
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('chat-runtime', LITERT_VERSION);

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('does not match a marker left by a different package version', async () => {
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('chat-runtime', '0.0.1-ancient');

    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('is false when nothing is loaded and there is no Cache Storage', async () => {
    const { isRuntimeCached } = await import('#/lib/chat/index');

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('does not spawn a worker to answer', async () => {
    // Runs during the check stage, so it must not start a worker — let alone
    // one that would go on to load 20 MB of wasm — to say whether that wasm is
    // already present.
    stubCacheStorage();
    const { isRuntimeCached } = await import('#/lib/chat/index');

    await isRuntimeCached();

    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('isCached', () => {
  it('is true immediately once a generate has completed in this session', async () => {
    stubCacheStorage();
    const { generateMessage, isCached } = await import('#/lib/chat/index');

    const promise = generateMessage({ prompt: 'hi' });
    only().emit({ id: 0, type: 'done', text: '' });
    await promise;

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not count an engine for a different context size as live', async () => {
    stubCacheStorage();
    const { generateMessage, isCached } = await import('#/lib/chat/index');

    const promise = generateMessage({ prompt: 'hi', maxNumTokens: 4096 });
    only().emit({ id: 0, type: 'done', text: '' });
    await promise;

    await expect(isCached(undefined, 8192)).resolves.toBe(false);
  });

  it('falls back to the step marker when nothing is live', async () => {
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    const { DEFAULT_CHAT_MODEL } = await import('#/lib/chat/constants');
    const { isCached } = await import('#/lib/chat/index');
    await markStep('chat', DEFAULT_CHAT_MODEL);

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not match a marker left by a different model', async () => {
    // Switching between the e2b and e4b builds has to miss, or the preload
    // screen would be skipped for a model that was never downloaded.
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    const { CHAT_MODELS } = await import('#/lib/chat/constants');
    const { isCached } = await import('#/lib/chat/index');
    await markStep('chat', CHAT_MODELS.e2b);

    await expect(isCached(CHAT_MODELS.e4b)).resolves.toBe(false);
  });

  it('does not spawn a worker to answer', async () => {
    stubCacheStorage();
    const { isCached } = await import('#/lib/chat/index');

    await isCached();

    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('endConversation', () => {
  it('asks the worker to drop its conversation, and still counts the engine as live', async () => {
    stubCacheStorage();
    const { generateMessage, isCached, endConversation } =
      await import('#/lib/chat/index');

    const generated = generateMessage({ prompt: 'hi' });
    only().emit({ id: 0, type: 'done', text: '' });
    await generated;

    const ended = endConversation();
    only().emit({ id: 1, type: 'done' });
    await ended;

    expect(only().postedMessages[1]).toEqual({
      id: 1,
      mode: 'end-conversation',
    });
    await expect(isCached()).resolves.toBe(true);
  });
});
