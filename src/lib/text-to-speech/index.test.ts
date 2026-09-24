import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/text-to-speech/messages';
import {
  isCached,
  isRuntimeCached,
  preload,
  openVoice,
  preloadRuntime,
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

const AUDIO = { buffer: new ArrayBuffer(1), mimeType: 'audio/wav' };

describe('openVoice', () => {
  it('starts loading the voice in a worker straight away', () => {
    openVoice(VOICES.es);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0].postedMessages).toEqual([
      { id: 0, mode: 'load', voiceId: VOICES.es },
    ]);
  });

  it('settles ready once the session has loaded', async () => {
    const voice = openVoice(VOICES.es);

    FakeWorker.instances[0].emit({ id: 0, type: 'done' });

    await expect(voice.ready).resolves.toBeUndefined();
  });

  it('speaks a line and resolves with the returned audio blob', async () => {
    const voice = openVoice(VOICES.en);
    const worker = FakeWorker.instances[0];
    const buffer = new TextEncoder().encode('audio bytes').buffer;

    const promise = voice.speak('hello');
    expect(worker.postedMessages[1]).toEqual({
      id: 1,
      mode: 'speak',
      voiceId: VOICES.en,
      text: 'hello',
    });
    worker.emit({ id: 1, type: 'done', buffer, mimeType: 'audio/wav' });

    const result = await promise;
    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('audio/wav');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('keeps one worker for every line', async () => {
    const voice = openVoice(VOICES.en);
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
    const voice = openVoice(VOICES.en);
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

  it('asks for a longer length scale when slow', () => {
    const voice = openVoice(VOICES.en);

    void voice.speak('hello', { slow: true });

    expect(FakeWorker.instances[0].postedMessages[1]).toEqual({
      id: 1,
      mode: 'speak',
      voiceId: VOICES.en,
      text: 'hello',
      lengthScale: SLOW_LENGTH_SCALE,
    });
  });

  it('reports startup as the round trip less the worker’s synthesis time', async () => {
    const voice = openVoice(VOICES.en);
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2600);
    const onTimings = vi.fn();

    const promise = voice.speak('hello', { onTimings });
    FakeWorker.instances[0].emit({
      id: 1,
      type: 'done',
      ...AUDIO,
      synthesisMs: 1500,
    });
    await promise;

    expect(onTimings).toHaveBeenCalledWith({ startup: 100, synthesis: 1500 });
    now.mockRestore();
  });

  it('keeps the timings callback out of the worker request', () => {
    // A function can't be structured-cloned; posting one would throw.
    const voice = openVoice(VOICES.en);

    void voice.speak('hello', { onTimings: vi.fn() });

    expect(FakeWorker.instances[0].postedMessages[1]).not.toHaveProperty(
      'onTimings',
    );
  });

  it('rejects a line the worker reports an error for, and keeps the worker', async () => {
    const voice = openVoice(VOICES.en);
    const worker = FakeWorker.instances[0];
    worker.emit({ id: 0, type: 'done' });

    const promise = voice.speak('hello');
    worker.emit({ id: 1, type: 'error', message: 'synth failed' });

    await expect(promise).rejects.toThrow('synth failed');
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('rejects when done arrives without audio data', async () => {
    const voice = openVoice(VOICES.en);

    const promise = voice.speak('hello');
    FakeWorker.instances[0].emit({ id: 1, type: 'done' });

    await expect(promise).rejects.toThrow('Worker returned no audio data.');
  });

  it('replaces a worker whose voice failed to load', async () => {
    // Piper keeps the failed session as its singleton, so that worker can
    // never load one now.
    const voice = openVoice(VOICES.en);
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
    const voice = openVoice(VOICES.en);
    const crashed = FakeWorker.instances[0];
    const line = voice.speak('hello');

    crashed.onerror?.(new Error('worker crashed'));

    await expect(line).rejects.toThrow('worker crashed');
    expect(crashed.terminate).toHaveBeenCalled();

    void voice.speak('again');
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('terminates the worker and refuses further lines once closed', async () => {
    const voice = openVoice(VOICES.en);
    const worker = FakeWorker.instances[0];
    const inFlight = voice.speak('hello');

    voice.close();

    expect(worker.terminate).toHaveBeenCalled();
    await expect(inFlight).rejects.toThrow('closed');
    await expect(voice.speak('again')).rejects.toThrow('closed');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('reports voice bytes streaming past the service worker while loading', async () => {
    // Normally silent — after preload the voice is in OPFS. This is the path
    // where the conversation was reached without one, or it has been evicted.
    const onProgress = vi.fn();
    const voice = openVoice(VOICES.en, onProgress);

    await report({
      step: 'text-to-speech',
      url: 'https://huggingface.co/piper-voices/model.onnx',
      loaded: 5,
      total: 10,
    });
    FakeWorker.instances[0].emit({ id: 0, type: 'done' });
    await voice.ready;

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ loaded: 5 }),
    );
  });

  it('stops listening once the voice has loaded', async () => {
    const onProgress = vi.fn();
    const voice = openVoice(VOICES.en, onProgress);

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
  it('loads the voice once and closes the worker', async () => {
    const promise = preload(VOICES.es);
    const worker = FakeWorker.instances[0];

    expect(worker.postedMessages).toEqual([
      { id: 0, mode: 'load', voiceId: VOICES.es },
    ]);

    worker.emit({ id: 0, type: 'done' });

    await expect(promise).resolves.toBeUndefined();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('rejects, and still closes the worker, when the voice fails to load', async () => {
    const promise = preload(VOICES.es);
    const worker = FakeWorker.instances[0];

    worker.emit({ id: 0, type: 'error', message: 'download failed' });

    await expect(promise).rejects.toThrow('download failed');
    expect(worker.terminate).toHaveBeenCalled();
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
