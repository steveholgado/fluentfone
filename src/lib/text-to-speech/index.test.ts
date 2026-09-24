import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/text-to-speech/messages';
import {
  isCached,
  isRuntimeCached,
  preload,
  preloadRuntime,
  speak,
  VOICES,
} from '#/lib/text-to-speech/index';
import {
  RUNTIME_KEY,
  SLOW_LENGTH_SCALE,
  WASM_FILES,
} from '#/lib/text-to-speech/constants';
import { hasStep, markStep } from '#/lib/cache/markers';
import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { stubCacheStorage } from '#/test-utils';

/** Stands in for the service worker. Delivery is asynchronous. */
let sw: BroadcastChannel | undefined;

async function report(message: AssetProgressMessage) {
  sw ??= new BroadcastChannel(PROGRESS_CHANNEL);
  sw.postMessage(message);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  terminate = vi.fn();
  postedMessages: WorkerRequest[] = [];

  constructor(
    public url: URL,
    public options?: { type: string },
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerRequest) {
    this.postedMessages.push(message);
  }

  emit(response: WorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  sw?.close();
  sw = undefined;
  vi.unstubAllGlobals();
});

describe('speak', () => {
  it('sends a speak request and resolves with the returned audio blob', async () => {
    const buffer = new TextEncoder().encode('audio bytes').buffer;
    const promise = speak(VOICES.en, 'hello');

    const worker = FakeWorker.instances[0];
    expect(worker.postedMessages[0]).toEqual({
      mode: 'speak',
      voiceId: VOICES.en,
      text: 'hello',
    });

    worker.emit({ type: 'done', buffer, mimeType: 'audio/wav' });

    const result = await promise;

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('audio/wav');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('asks for a longer length scale when slow', () => {
    void speak(VOICES.en, 'hello', undefined, { slow: true });

    expect(FakeWorker.instances[0].postedMessages[0]).toEqual({
      mode: 'speak',
      voiceId: VOICES.en,
      text: 'hello',
      lengthScale: SLOW_LENGTH_SCALE,
    });
  });

  it('rejects and terminates the worker when it reports an error', async () => {
    const promise = speak(VOICES.en, 'hello');
    const worker = FakeWorker.instances[0];

    worker.emit({ type: 'error', message: 'synth failed' });

    await expect(promise).rejects.toThrow('synth failed');
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects when the worker itself errors', async () => {
    const promise = speak(VOICES.en, 'hello');
    const worker = FakeWorker.instances[0];

    worker.onerror?.(new Error('worker crashed'));

    await expect(promise).rejects.toBeTruthy();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects when done arrives without audio data', async () => {
    const promise = speak(VOICES.en, 'hello');
    const worker = FakeWorker.instances[0];

    worker.emit({ type: 'done' });

    await expect(promise).rejects.toThrow('Worker returned no audio data.');
  });

  it('reports voice bytes streaming past the service worker', async () => {
    // Normally silent — after preload the voice is in OPFS. This is the path
    // where the conversation was reached without one, or it has been evicted.
    const onProgress = vi.fn();
    const promise = speak(VOICES.en, 'hello', onProgress);
    const worker = FakeWorker.instances[0];

    await report({
      step: 'text-to-speech',
      url: 'https://huggingface.co/piper-voices/model.onnx',
      loaded: 5,
      total: 10,
    });

    worker.emit({
      type: 'done',
      buffer: new ArrayBuffer(1),
      mimeType: 'audio/wav',
    });
    await promise;

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ loaded: 5 }),
    );
  });

  it('stops listening once the call is over', async () => {
    const onProgress = vi.fn();
    const promise = speak(VOICES.en, 'hello', onProgress);

    FakeWorker.instances[0].emit({
      type: 'done',
      buffer: new ArrayBuffer(1),
      mimeType: 'audio/wav',
    });
    await promise;
    onProgress.mockClear();

    await report({
      step: 'text-to-speech',
      url: 'https://huggingface.co/piper-voices/model.onnx',
      loaded: 5,
      total: 10,
    });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('preload', () => {
  it('sends a preload request for the given voice', async () => {
    const promise = preload(VOICES.es);
    const worker = FakeWorker.instances[0];

    expect(worker.postedMessages[0]).toEqual({
      mode: 'preload',
      voiceId: VOICES.es,
    });

    worker.emit({ type: 'done' });

    await expect(promise).resolves.toBeUndefined();
  });
});

describe('preloadRuntime', () => {
  it('pulls the vendored wasm through and marks the step', async () => {
    stubCacheStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);

    await preloadRuntime();

    // Fetched here rather than left to TtsSession.create(), so the wasm and
    // the voice each get their own progress sweep. Cheap to do because these
    // URLs are ours — there is no build variant to guess at.
    expect(fetchMock).toHaveBeenCalledTimes(WASM_FILES.length);
    expect(FakeWorker.instances).toHaveLength(0);
    await expect(hasStep('text-to-speech-runtime', RUNTIME_KEY)).resolves.toBe(
      true,
    );
  });

  it('does not mark the step if a file fails to download', async () => {
    stubCacheStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );

    await expect(preloadRuntime()).rejects.toThrow('Failed to download');
    await expect(hasStep('text-to-speech-runtime', RUNTIME_KEY)).resolves.toBe(
      false,
    );
  });
});

describe('isRuntimeCached', () => {
  it('is false when nothing has been downloaded and there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('is true when the step marker is present', async () => {
    stubCacheStorage();
    await markStep('text-to-speech-runtime', RUNTIME_KEY);

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('does not match a marker from a different vendored version', async () => {
    // Both paths carry their package version, so a bump misses rather than
    // vouching for wasm that was never fetched.
    stubCacheStorage();
    await markStep('text-to-speech-runtime', '/vendor/onnx/0.0.1/|/vendor/x/');

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('neither fetches nor spawns a worker', async () => {
    // Runs during the check stage, before the user has agreed to download
    // anything.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', undefined);

    await isRuntimeCached();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });
});

describe('isCached', () => {
  /** Stubs OPFS with a `piper` directory holding the given file names. */
  function stubOpfs(names: string[]) {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getDirectoryHandle: async () => ({
            keys: async function* () {
              yield* names;
            },
          }),
        }),
      },
    });
  }

  it('resolves true when the voice model is in OPFS', async () => {
    stubOpfs(['es_ES-davefx-medium.onnx', 'es_ES-davefx-medium.onnx.json']);

    await expect(isCached('es_ES-davefx-medium')).resolves.toBe(true);
  });

  it('resolves false when a different voice is stored', async () => {
    stubOpfs(['en_US-hfc_female-medium.onnx']);

    await expect(isCached('es_ES-davefx-medium')).resolves.toBe(false);
  });

  it('ignores the sidecar config file when no weights are present', async () => {
    stubOpfs(['es_ES-davefx-medium.onnx.json']);

    await expect(isCached('es_ES-davefx-medium')).resolves.toBe(false);
  });

  it('does not spawn a worker', async () => {
    // The check stage runs before the user has agreed to download anything,
    // so it must not pull in piper-tts-web's bundle.
    stubOpfs(['es_ES-davefx-medium.onnx']);

    await isCached('es_ES-davefx-medium');

    expect(FakeWorker.instances).toHaveLength(0);
  });
});
