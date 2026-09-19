import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/text-to-speech/messages';
import {
  isCached,
  isRuntimeCached,
  preload,
  speak,
  VOICES,
} from '#/lib/text-to-speech/index';

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

  it('forwards progress updates', async () => {
    const onProgress = vi.fn();
    const promise = speak(VOICES.en, 'hello', onProgress);
    const worker = FakeWorker.instances[0];

    worker.emit({
      type: 'progress',
      progress: { url: 'https://voice/model.onnx', loaded: 5, total: 10 },
    });
    worker.emit({
      type: 'done',
      buffer: new ArrayBuffer(1),
      mimeType: 'audio/wav',
    });

    await promise;

    expect(onProgress).toHaveBeenCalledWith({
      loaded: 5,
      total: 10,
      progress: 0.5,
    });
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

describe('isRuntimeCached', () => {
  it('is false when nothing has been warmed and there is no Cache Storage', async () => {
    vi.stubGlobal('caches', undefined);

    await expect(isRuntimeCached()).resolves.toBe(false);
  });

  it('is true when the runtime receipt is present', async () => {
    vi.stubGlobal('caches', {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(new Response('1')),
      }),
    });

    await expect(isRuntimeCached()).resolves.toBe(true);
  });

  it('neither fetches nor spawns a worker', async () => {
    // Runs during the check stage. A probe of the HTTP cache here would show
    // up as a failed request in the network panel on every cold load.
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
