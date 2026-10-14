import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROGRESS_CHANNEL,
  type AssetProgressMessage,
} from '#/lib/cache/channel';
import { hasStep, markStep } from '#/lib/cache/markers';
import { MODELS_CACHE } from '#/lib/cache/names';
import {
  RUNTIME_KEY,
  voiceUrls,
  WASM_FILES,
} from '#/lib/text-to-speech/constants';
import {
  isCached,
  isRuntimeCached,
  preload,
  openVoice,
  preloadRuntime,
  VOICES,
} from '#/lib/text-to-speech/index';
import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/text-to-speech/messages';
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

const AUDIO = { buffer: new ArrayBuffer(1), mimeType: 'audio/wav' };

describe('openVoice', () => {
  it('starts loading the voice in a worker straight away', () => {
    openVoice(VOICES.es_ES[0]);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].postedMessages).toEqual([
      { id: 0, mode: 'load', voiceId: VOICES.es_ES[0] },
    ]);
  });

  it('settles ready once the session has loaded', async () => {
    const voice = openVoice(VOICES.es_ES[0]);

    FakeWorker.instances[0].emit({ id: 0, type: 'done' });

    await expect(voice.ready).resolves.toBeUndefined();
  });

  it('speaks a line and resolves with the returned audio blob', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const worker = FakeWorker.instances[0];
    const buffer = new TextEncoder().encode('audio bytes').buffer;

    const promise = voice.speak('hello');
    expect(worker.postedMessages[1]).toEqual({
      id: 1,
      mode: 'speak',
      voiceId: VOICES.en_US[0],
      text: 'hello',
    });
    worker.emit({ id: 1, type: 'done', buffer, mimeType: 'audio/wav' });

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('audio/wav');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps one worker for every line', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const worker = FakeWorker.instances[0];

    const first = voice.speak('uno');
    worker.emit({ id: 1, type: 'done', ...AUDIO });
    await first;
    const second = voice.speak('dos');
    worker.emit({ id: 2, type: 'done', ...AUDIO });
    await second;

    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.postedMessages.map((m) => m.mode)).toEqual([
      'load',
      'speak',
      'speak',
    ]);
  });

  it('matches replies to lines by id', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const worker = FakeWorker.instances[0];

    const first = voice.speak('uno');
    const second = voice.speak('dos');
    worker.emit({
      id: 2,
      type: 'done',
      buffer: new ArrayBuffer(2),
      mimeType: 'audio/b',
    });
    worker.emit({
      id: 1,
      type: 'done',
      buffer: new ArrayBuffer(1),
      mimeType: 'audio/a',
    });

    await expect(first).resolves.toHaveProperty('type', 'audio/a');
    await expect(second).resolves.toHaveProperty('type', 'audio/b');
  });

  it('asks for no length scale at natural speed', () => {
    const voice = openVoice(VOICES.en_US[0]);

    void voice.speak('hello', { speed: 1 });

    expect(FakeWorker.instances[0].postedMessages[1]).not.toHaveProperty(
      'lengthScale',
    );
  });

  it('asks for the inverse length scale at any other speed', () => {
    const voice = openVoice(VOICES.en_US[0]);

    void voice.speak('hello', { speed: 0.8 });

    expect(FakeWorker.instances[0].postedMessages[1]).toEqual({
      id: 1,
      mode: 'speak',
      voiceId: VOICES.en_US[0],
      text: 'hello',
      lengthScale: 1.25,
    });
  });

  it('rejects a line the worker reports an error for, and keeps the worker', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'done' });

    const promise = voice.speak('hello');
    worker.emit({ id: 1, type: 'error', message: 'synth failed' });

    await expect(promise).rejects.toThrow('synth failed');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('rejects when done arrives without audio data', async () => {
    const voice = openVoice(VOICES.en_US[0]);

    const promise = voice.speak('hello');
    FakeWorker.instances[0].emit({ id: 1, type: 'done' });

    await expect(promise).rejects.toThrow('Worker returned no audio data.');
  });

  it('replaces a worker whose voice failed to load', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const failed = FakeWorker.instances[0];
    const line = voice.speak('hello');

    failed.emit({ id: 0, type: 'error', message: 'voice missing' });

    await expect(voice.ready).rejects.toThrow('voice missing');
    await expect(line).rejects.toThrow('voice missing');
    expect(failed.terminate).toHaveBeenCalled();

    void voice.speak('again');
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1].postedMessages.map((m) => m.mode)).toEqual([
      'load',
      'speak',
    ]);
  });

  it('replaces a worker that crashed', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const crashed = FakeWorker.instances[0];
    const line = voice.speak('hello');

    crashed.onerror?.(new Error('worker crashed'));

    await expect(line).rejects.toThrow('worker crashed');
    expect(crashed.terminate).toHaveBeenCalled();

    void voice.speak('again');
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('terminates the worker and refuses further lines once closed', async () => {
    const voice = openVoice(VOICES.en_US[0]);
    const worker = FakeWorker.instances[0];
    const inFlight = voice.speak('hello');

    voice.close();

    expect(worker.terminate).toHaveBeenCalled();
    await expect(inFlight).rejects.toThrow('closed');
    await expect(voice.speak('again')).rejects.toThrow('closed');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('reports voice bytes streaming past the service worker while loading', async () => {
    // Normally silent — after preload the voice comes out of the service
    // worker's cache. This is the path where the conversation was reached
    // without one, or it has been evicted.
    const onProgress = vi.fn();
    const voice = openVoice(VOICES.en_US[0], onProgress);

    await report({
      step: 'text-to-speech',
      url: 'https://huggingface.co/piper-voices/model.onnx',
      loaded: 5,
      total: 10,
    });
    // Waited for rather than assumed: BroadcastChannel delivery can take more
    // than the one tick `report` allows when the machine is busy, and loading
    // the voice first would stop the listening the report is meant to reach.
    await vi.waitFor(() =>
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ loaded: 5 }),
      ),
    );

    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await voice.ready;
  });

  it('stops listening once the voice has loaded', async () => {
    const onProgress = vi.fn();
    const voice = openVoice(VOICES.en_US[0], onProgress);

    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await voice.ready;
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
  it('pulls the voice’s model and config through, without a worker', async () => {
    // Downloading is all a preload needs; the session is built when the
    // conversation opens the voice.
    const fetchMock = vi.fn(
      async (_url: string) => new Response(new Uint8Array([1])),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { model, config } = voiceUrls(VOICES.es_ES[0]);

    await preload(VOICES.es_ES[0]);

    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(
      [model, config].sort(),
    );
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('rejects when a file fails to download', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );

    await expect(preload(VOICES.es_ES[0])).rejects.toThrow(
      'Failed to download voice (404)',
    );
  });
});

describe('preloadRuntime', () => {
  it('pulls the vendored wasm through and marks the step', async () => {
    stubCacheStorage();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1])));
    vi.stubGlobal('fetch', fetchMock);

    await preloadRuntime();

    // Fetched here rather than left to the first session, so the wasm and
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
  const VOICE_ID = 'es_ES-davefx-medium';

  /** Puts the given files in the models cache, as the service worker would. */
  async function stored(urls: string[]) {
    stubCacheStorage();
    const cache = await caches.open(MODELS_CACHE);
    for (const url of urls) await cache.put(url, new Response('x'));
  }

  it('resolves true when the voice’s model and config are both cached', async () => {
    const { model, config } = voiceUrls(VOICE_ID);
    await stored([model, config]);

    await expect(isCached(VOICE_ID)).resolves.toBe(true);
  });

  it('resolves false when only one of them is', async () => {
    const { model, config } = voiceUrls(VOICE_ID);

    await stored([model]);
    await expect(isCached(VOICE_ID)).resolves.toBe(false);

    await stored([config]);
    await expect(isCached(VOICE_ID)).resolves.toBe(false);
  });

  it('resolves false when a different voice is cached', async () => {
    const { model, config } = voiceUrls('en_US-hfc_female-medium');
    await stored([model, config]);

    await expect(isCached(VOICE_ID)).resolves.toBe(false);
  });

  it('neither fetches nor spawns a worker', async () => {
    // The check stage runs before the user has agreed to download anything.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await stored([]);

    await isCached(VOICE_ID);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });
});
