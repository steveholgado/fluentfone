import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRequest } from '#/lib/speech-to-text/messages';

const transcriberFn = vi.fn();
const pipelineFactory = vi.fn();

const env = { useBrowserCache: true };

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineFactory(...args),
  env,
}));

const createSession = vi.fn();
const InferenceSession = { create: createSession };

vi.mock('onnxruntime-web/webgpu', () => ({ InferenceSession }));

let postedMessages: unknown[] = [];
let onmessage: ((event: MessageEvent<WorkerRequest>) => void) | undefined;

function post(request: WorkerRequest) {
  return onmessage?.({ data: request } as MessageEvent<WorkerRequest>);
}

beforeEach(async () => {
  postedMessages = [];
  env.useBrowserCache = true;
  InferenceSession.create = createSession;
  pipelineFactory.mockResolvedValue(transcriberFn);
  transcriberFn.mockResolvedValue({ text: '  hello world  ' });

  vi.stubGlobal('navigator', {});
  vi.stubGlobal('self', {
    postMessage: (msg: unknown) => postedMessages.push(msg),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });

  await import('#/lib/speech-to-text/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('worker onmessage', () => {
  it('transcribes audio and posts the trimmed text with the matching id', async () => {
    await post({
      id: 7,
      mode: 'transcribe',
      audio: new Float32Array([0.1]),
    });

    expect(postedMessages).toEqual([
      {
        id: 7,
        type: 'done',
        text: 'hello world',
        inferenceMs: expect.any(Number),
        device: 'wasm',
      },
    ]);
    expect(transcriberFn).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ task: 'transcribe' }),
    );
  });

  it('passes language and task options through to the pipeline call', async () => {
    await post({
      id: 1,
      mode: 'transcribe',
      audio: new Float32Array([0.1]),
      language: 'spanish',
      task: 'translate',
    });

    expect(transcriberFn).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ language: 'spanish', task: 'translate' }),
    );
  });

  it('handles an array result by using the first entry', async () => {
    transcriberFn.mockResolvedValue([{ text: 'first' }, { text: 'second' }]);

    await post({ id: 2, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages).toEqual([
      expect.objectContaining({ id: 2, type: 'done', text: 'first' }),
    ]);
  });

  it('returns an empty string when the result has no text', async () => {
    transcriberFn.mockResolvedValue({});

    await post({ id: 3, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages).toEqual([
      expect.objectContaining({ id: 3, type: 'done', text: '' }),
    ]);
  });

  it('reports how long the pipeline call took', async () => {
    // The first transcribe builds the pipeline; only the call itself is timed.
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(3400);

    await post({ id: 8, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages[0]).toMatchObject({ inferenceMs: 3300 });
    now.mockRestore();
  });

  it('reports webgpu as the device when the pipeline was built on it', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { gpu: {} });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 9, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages[0]).toMatchObject({ device: 'webgpu' });
  });

  it('builds the pipeline once across multiple messages', async () => {
    await post({ id: 4, mode: 'transcribe', audio: new Float32Array([0.1]) });
    await post({ id: 5, mode: 'transcribe', audio: new Float32Array([0.2]) });

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('answers a preload request once the pipeline is built', async () => {
    await post({ id: 6, mode: 'preload' });

    expect(postedMessages).toEqual([{ id: 6, type: 'done' }]);
  });

  it('stops Transformers.js keeping a second copy of every weight file', async () => {
    // It would otherwise write its own `transformers-cache` bucket alongside
    // the one the service worker already holds — the same bytes twice, and a
    // second place to ask whether they are present.
    await post({ id: 1, mode: 'preload' });

    expect(env.useBrowserCache).toBe(false);
  });

  it('hands ORT the weights as external data on WebGPU', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { gpu: {} });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 1, mode: 'preload' });

    expect(InferenceSession.create).not.toBe(createSession);
  });

  it('leaves ORT alone on the wasm path', async () => {
    await post({ id: 1, mode: 'preload' });

    expect(InferenceSession.create).toBe(createSession);
  });

  it('loads q8 weights on the wasm path', async () => {
    await post({ id: 1, mode: 'preload' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({ dtype: 'q8' });
  });

  it('loads an fp16 encoder and q4 decoder on a GPU with shader-f16', async () => {
    // q8 runs on WebGPU but ~8× slower per utterance.
    vi.resetModules();
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
      },
    });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 1, mode: 'preload' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({
      dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    });
  });

  // Transformers.js refuses fp16 weights on such a GPU rather than falling
  // back, so they mustn't be asked for.
  it('loads an fp32 encoder and q4 decoder on a GPU without shader-f16', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => ({ features: new Set() }) },
    });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 1, mode: 'preload' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    });
  });

  it('posts an error message when transcription throws', async () => {
    transcriberFn.mockRejectedValue(new Error('boom'));

    await post({ id: 10, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages).toEqual([
      { id: 10, type: 'error', message: 'boom' },
    ]);
  });

  it('stringifies non-Error throwables', async () => {
    pipelineFactory.mockRejectedValue('plain string failure');

    await post({ id: 11, mode: 'preload' });

    expect(postedMessages).toEqual([
      { id: 11, type: 'error', message: 'plain string failure' },
    ]);
  });
});
