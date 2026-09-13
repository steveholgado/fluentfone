import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  WorkerRequest,
  WorkerResponse,
} from '#/lib/text-to-speech/messages';
import { isCached, preload, speak, VOICES } from '#/lib/text-to-speech/index';

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

describe('isCached', () => {
  it('resolves true when the worker reports the voice as stored', async () => {
    const promise = isCached(VOICES.en);
    const worker = FakeWorker.instances[0];

    expect(worker.postedMessages[0]).toEqual({
      mode: 'check',
      voiceId: VOICES.en,
    });

    worker.emit({ type: 'done', stored: true });

    await expect(promise).resolves.toBe(true);
  });

  it('resolves false when the worker reports the voice as not stored', async () => {
    const promise = isCached(VOICES.en);
    FakeWorker.instances[0].emit({ type: 'done', stored: false });

    await expect(promise).resolves.toBe(false);
  });
});
