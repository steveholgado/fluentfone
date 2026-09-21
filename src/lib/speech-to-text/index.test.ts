import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as audio from '#/lib/audio';
import { stubCacheStorage } from '#/test-utils';
import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/speech-to-text/messages';

// The barrel, because that is what index.ts imports. Only toMonoPcm is stubbed
// — nothing else in `#/lib/audio` is reachable from speech-to-text.
vi.mock('#/lib/audio', () => ({
  toMonoPcm: vi.fn(),
}));

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

// `transcribe()` awaits `toMonoPcm()` before it creates the worker or posts
// a message, so tests need to let that microtask settle before touching
// `FakeWorker.instances`.
const flush = () => Promise.resolve();

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('caches', undefined);
  vi.mocked(audio.toMonoPcm).mockResolvedValue(new Float32Array([0.1]));
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('transcribe', () => {
  it('decodes the audio and returns the trimmed transcription text', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']));
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'done', text: 'hello world' });

    await expect(promise).resolves.toBe('hello world');
    expect(audio.toMonoPcm).toHaveBeenCalledWith(expect.any(Blob), 16000);
  });

  it('passes language and task options through to the worker request', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']), {
      language: 'spanish',
      task: 'translate',
    });
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'done', text: '' });
    await promise;

    expect(worker.postedMessages[0]).toEqual(
      expect.objectContaining({ language: 'spanish', task: 'translate' }),
    );
  });

  it('defaults to the transcribe task', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']));
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'done', text: '' });
    await promise;

    expect(worker.postedMessages[0]).toEqual(
      expect.objectContaining({ task: 'transcribe' }),
    );
  });

  it('rejects when the worker reports an error', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']));
    await flush();
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'error', message: 'transcription failed' });

    await expect(promise).rejects.toThrow('transcription failed');
  });

  it('resolves overlapping calls to their own results', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const first = transcribe(new Blob(['a']));
    const second = transcribe(new Blob(['b']));
    await flush();
    const worker = FakeWorker.instances[0];

    expect(worker.postedMessages.map((m) => m.id)).toEqual([0, 1]);

    // Resolve out of order to prove results aren't mixed up.
    worker.emit({ id: 1, type: 'done', text: 'second' });
    worker.emit({ id: 0, type: 'done', text: 'first' });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('reuses a single worker across multiple calls', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const first = transcribe(new Blob(['a']));
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done', text: '' });
    await first;

    const second = transcribe(new Blob(['b']));
    await flush();
    FakeWorker.instances[0].emit({ id: 1, type: 'done', text: '' });
    await second;

    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe('preload', () => {
  it('sends a preload request and marks the step once it lands', async () => {
    stubCacheStorage();
    const { preload } = await import('#/lib/speech-to-text/index');
    const { hasStep } = await import('#/lib/cache/markers');
    const { MODEL_KEY } = await import('#/lib/speech-to-text/constants');

    const promise = preload();
    await flush();
    const worker = FakeWorker.instances[0];

    // No 'runtime' request any more: Transformers.js downloads its ONNX
    // Runtime as part of building the pipeline, and the service worker
    // reports the bytes rather than us fetching them first.
    expect(worker.postedMessages[0]).toEqual({ id: 0, mode: 'preload' });

    worker.emit({ id: 0, type: 'done' });
    await promise;

    await expect(hasStep('speech-to-text', MODEL_KEY)).resolves.toBe(true);
  });
});

describe('isCached', () => {
  it('is true once a transcription has completed in this session', async () => {
    const { transcribe, isCached } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']));
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done', text: '' });
    await promise;

    await expect(isCached()).resolves.toBe(true);
  });

  it('is false when nothing has completed and there is no Cache Storage', async () => {
    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
  });

  it('is true when the step marker is present', async () => {
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    const { MODEL_KEY } = await import('#/lib/speech-to-text/constants');
    await markStep('speech-to-text', MODEL_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not match a marker left by a different model or precision', async () => {
    // The marker carries the model and dtype, so changing either misses
    // rather than vouching for weights that were never downloaded.
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', 'onnx-community/whisper-tiny:fp16');

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
  });

  it('does not spawn a worker', async () => {
    // Runs during the check stage, so it must not pull in the 500 KB
    // Transformers.js chunk the worker would load.
    stubCacheStorage();
    const { isCached } = await import('#/lib/speech-to-text/index');

    await isCached();

    expect(FakeWorker.instances).toHaveLength(0);
  });
});
