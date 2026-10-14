import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as audio from '#/lib/audio';
import { MODEL_REVISION } from '#/lib/speech-to-text/constants';
import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/speech-to-text/messages';
import { stubCacheStorage } from '#/test-utils';

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

// Spelled out rather than read from constants.ts, whose modelKey() answers for
// whichever GPU the test stubs. The revision doesn't depend on the GPU, so
// that part is read. WEBGPU_KEY is a GPU without shader-f16, which is what
// `{ gpu: {} }` amounts to: it has no adapter to ask.
const Q8_KEY = `onnx-community/whisper-small@${MODEL_REVISION}:q8`;
const WEBGPU_KEY = `onnx-community/whisper-small@${MODEL_REVISION}:fp32+q4`;
const F16_KEY = `onnx-community/whisper-small@${MODEL_REVISION}:fp16+q4`;

const F16_GPU = {
  requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
};

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

  it('rejects everything in flight when the worker itself fails', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const first = transcribe(new Blob(['a']));
    const second = transcribe(new Blob(['b']));
    await flush();
    FakeWorker.instances[0].emitError(
      new ErrorEvent('error', { message: 'worker died' }),
    );

    await expect(first).rejects.toThrow('worker died');
    await expect(second).rejects.toThrow('worker died');
  });

  it('says the worker failed when its error carries no message', async () => {
    // A worker that fails to load reports an ErrorEvent with no message, which
    // must not reach the UI as "[object ErrorEvent]".
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const promise = transcribe(new Blob(['audio']));
    await flush();
    FakeWorker.instances[0].emitError(new ErrorEvent('error'));

    await expect(promise).rejects.toThrow('Speech-to-text worker failed.');
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

    const promise = preload();
    await flush();
    const worker = FakeWorker.instances[0];

    // One request for runtime and weights alike: the runtime's URLs are only
    // known once Transformers.js has loaded, in the worker.
    expect(worker.postedMessages[0]).toEqual({ id: 0, mode: 'preload' });

    worker.emit({ id: 0, type: 'done' });
    await promise;

    await expect(hasStep('speech-to-text', Q8_KEY)).resolves.toBe(true);
  });

  it('marks the WebGPU weights when the pipeline is built on WebGPU', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    stubCacheStorage();
    const { preload } = await import('#/lib/speech-to-text/index');
    const { hasStep } = await import('#/lib/cache/markers');

    const promise = preload();
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await promise;

    await expect(hasStep('speech-to-text', WEBGPU_KEY)).resolves.toBe(true);
    await expect(hasStep('speech-to-text', Q8_KEY)).resolves.toBe(false);
  });

  it('marks the fp16 encoder’s weights on a GPU with shader-f16', async () => {
    vi.stubGlobal('navigator', { gpu: F16_GPU });
    stubCacheStorage();
    const { preload } = await import('#/lib/speech-to-text/index');
    const { hasStep } = await import('#/lib/cache/markers');

    const promise = preload();
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await promise;

    await expect(hasStep('speech-to-text', F16_KEY)).resolves.toBe(true);
    await expect(hasStep('speech-to-text', WEBGPU_KEY)).resolves.toBe(false);
  });

  it('does not count as a built pipeline', async () => {
    // Only downloaded: with no marker to read, nothing is ready.
    const { preload, isCached } = await import('#/lib/speech-to-text/index');

    const promise = preload();
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await promise;

    await expect(isCached()).resolves.toBe(false);
  });
});

describe('load', () => {
  it('asks the worker to build the pipeline', async () => {
    const { load, isCached } = await import('#/lib/speech-to-text/index');

    const promise = load();
    await flush();
    const worker = FakeWorker.instances[0];

    expect(worker.postedMessages[0]).toEqual({ id: 0, mode: 'load' });

    worker.emit({ id: 0, type: 'done' });
    await promise;

    await expect(isCached()).resolves.toBe(true);
  });

  it('marks no step', async () => {
    // Building reads whatever the preload put on disk, or downloads it; only
    // a preload vouches for the files being there.
    stubCacheStorage();
    const { load } = await import('#/lib/speech-to-text/index');
    const { hasStep } = await import('#/lib/cache/markers');

    const promise = load();
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await promise;

    await expect(hasStep('speech-to-text', Q8_KEY)).resolves.toBe(false);
  });

  it('rejects when the worker reports an error', async () => {
    const { load, isCached } = await import('#/lib/speech-to-text/index');

    const promise = load();
    await flush();
    FakeWorker.instances[0].emit({ id: 0, type: 'error', message: 'no gpu' });

    await expect(promise).rejects.toThrow('no gpu');
    await expect(isCached()).resolves.toBe(false);
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

  it('is true when the q8 marker is present on the wasm path', async () => {
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', Q8_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(true);
  });

  it('is true when the WebGPU marker is present on WebGPU', async () => {
    vi.stubGlobal('navigator', { gpu: {} });
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', WEBGPU_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not let a q8 marker vouch for the WebGPU weights', async () => {
    // A q8 install has different files on disk. Counting its marker would
    // skip preload and leave the first transcription to download the WebGPU
    // weights mid-conversation.
    vi.stubGlobal('navigator', { gpu: {} });
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', Q8_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
  });

  it('is true when the fp16 marker is present on a GPU with shader-f16', async () => {
    vi.stubGlobal('navigator', { gpu: F16_GPU });
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', F16_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(true);
  });

  it('does not let an fp32 marker vouch for the fp16 weights', async () => {
    // What a device that downloaded before the switch to fp16 holds: the
    // fp16 encoder isn't on disk, and has to be downloaded at preload rather
    // than mid-conversation.
    vi.stubGlobal('navigator', { gpu: F16_GPU });
    stubCacheStorage();
    const { markStep } = await import('#/lib/cache/markers');
    await markStep('speech-to-text', WEBGPU_KEY);

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
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
