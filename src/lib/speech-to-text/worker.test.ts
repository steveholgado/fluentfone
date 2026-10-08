import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_BASE, MODEL_REVISION } from '#/lib/speech-to-text/constants';
import type { WorkerRequest } from '#/lib/speech-to-text/messages';

const transcriberFn = vi.fn();
const pipelineFactory = vi.fn();
const getPipelineFiles = vi.fn();

const RUNTIME = {
  mjs: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort.mjs',
  wasm: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort.wasm',
};

const MODEL_FILES = ['config.json', 'onnx/encoder_model.onnx'];

const env = {
  useBrowserCache: true,
  backends: { onnx: { wasm: { wasmPaths: { ...RUNTIME } } } },
};

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineFactory(...args),
  ModelRegistry: {
    get_pipeline_files: (...args: unknown[]) => getPipelineFiles(...args),
  },
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
  env.backends.onnx.wasm.wasmPaths = { ...RUNTIME };
  InferenceSession.create = createSession;
  pipelineFactory.mockResolvedValue(transcriberFn);
  getPipelineFiles.mockResolvedValue(MODEL_FILES);
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
      { id: 7, type: 'done', text: 'hello world' },
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

    expect(postedMessages).toEqual([{ id: 2, type: 'done', text: 'first' }]);
  });

  it('returns an empty string when the result has no text', async () => {
    transcriberFn.mockResolvedValue({});

    await post({ id: 3, mode: 'transcribe', audio: new Float32Array([0.1]) });

    expect(postedMessages).toEqual([{ id: 3, type: 'done', text: '' }]);
  });

  it('builds the pipeline on the wasm backend without WebGPU', async () => {
    await post({ id: 8, mode: 'load' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({ device: 'wasm' });
  });

  it('builds the pipeline on WebGPU when it is available', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { gpu: {} });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 9, mode: 'load' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({
      device: 'webgpu',
    });
  });

  it('builds the pipeline once across multiple messages', async () => {
    await post({ id: 4, mode: 'transcribe', audio: new Float32Array([0.1]) });
    await post({ id: 5, mode: 'transcribe', audio: new Float32Array([0.2]) });

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('answers a load request once the pipeline is built', async () => {
    await post({ id: 6, mode: 'load' });

    expect(postedMessages).toEqual([{ id: 6, type: 'done' }]);
  });

  it('stops Transformers.js keeping a second copy of every weight file', async () => {
    // It would otherwise write its own `transformers-cache` bucket alongside
    // the one the service worker already holds — the same bytes twice, and a
    // second place to ask whether they are present.
    await post({ id: 1, mode: 'load' });

    expect(env.useBrowserCache).toBe(false);
  });

  it('hands ORT the weights as external data on WebGPU', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { gpu: {} });
    await import('#/lib/speech-to-text/worker');

    await post({ id: 1, mode: 'load' });

    expect(InferenceSession.create).not.toBe(createSession);
  });

  it('leaves ORT alone on the wasm path', async () => {
    await post({ id: 1, mode: 'load' });

    expect(InferenceSession.create).toBe(createSession);
  });

  it('loads q8 weights on the wasm path', async () => {
    await post({ id: 1, mode: 'load' });

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

    await post({ id: 1, mode: 'load' });

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

    await post({ id: 1, mode: 'load' });

    expect(pipelineFactory.mock.calls[0][2]).toMatchObject({
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    });
  });

  describe('preload', () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(new Uint8Array([1])),
    );

    beforeEach(() => {
      fetchMock.mockClear();
      vi.stubGlobal('fetch', fetchMock);
    });

    const fetched = () => fetchMock.mock.calls.map(([url]) => url).sort();

    it('downloads the runtime and weights without building the pipeline', async () => {
      // Building holds both weight files whole, and more, which is a peak the
      // download screen has no use for.
      await post({ id: 6, mode: 'preload' });

      expect(postedMessages).toEqual([{ id: 6, type: 'done' }]);
      expect(pipelineFactory).not.toHaveBeenCalled();
      expect(fetched()).toEqual(
        [
          RUNTIME.mjs,
          RUNTIME.wasm,
          ...MODEL_FILES.map((file) => `${MODEL_BASE}${file}`),
        ].sort(),
      );
    });

    it('asks the registry for the q8 files on the wasm path', async () => {
      await post({ id: 1, mode: 'preload' });

      expect(getPipelineFiles).toHaveBeenCalledWith(
        'automatic-speech-recognition',
        'onnx-community/whisper-small',
        { device: 'wasm', dtype: 'q8' },
      );
    });

    it('asks for the fp16 encoder under its session key too', async () => {
      // 4.3.0's registry looks the encoder up as `model`, the pipeline as
      // `encoder_model`; given only the latter, it names the fp32 encoder.
      vi.resetModules();
      vi.stubGlobal('navigator', {
        gpu: {
          requestAdapter: async () => ({ features: new Set(['shader-f16']) }),
        },
      });
      await import('#/lib/speech-to-text/worker');

      await post({ id: 1, mode: 'preload' });

      expect(getPipelineFiles).toHaveBeenCalledWith(
        'automatic-speech-recognition',
        'onnx-community/whisper-small',
        {
          device: 'webgpu',
          dtype: {
            model: 'fp16',
            encoder_model: 'fp16',
            decoder_model_merged: 'q4',
          },
        },
      );
    });

    it('asks for the fp32 encoder on a GPU without shader-f16', async () => {
      vi.resetModules();
      vi.stubGlobal('navigator', {
        gpu: { requestAdapter: async () => ({ features: new Set() }) },
      });
      await import('#/lib/speech-to-text/worker');

      await post({ id: 1, mode: 'preload' });

      expect(getPipelineFiles.mock.calls[0][2]).toMatchObject({
        dtype: { model: 'fp32', encoder_model: 'fp32' },
      });
    });

    it('sets Transformers.js up before asking it for anything', async () => {
      // The revision especially: the registry fetches config.json to answer.
      getPipelineFiles.mockImplementation(async () => {
        expect(env).toMatchObject({
          useBrowserCache: false,
          remotePathTemplate: `{model}/resolve/${MODEL_REVISION}/`,
        });
        return MODEL_FILES;
      });

      await post({ id: 1, mode: 'preload' });

      expect(postedMessages).toEqual([{ id: 1, type: 'done' }]);
    });

    it('skips a runtime file the library has already loaded', async () => {
      // Transformers.js swaps a blob URL in once it holds the runtime.
      env.backends.onnx.wasm.wasmPaths.mjs = 'blob:https://app/ort';

      await post({ id: 1, mode: 'preload' });

      expect(fetched()).not.toContain('blob:https://app/ort');
      expect(fetched()).toContain(RUNTIME.wasm);
    });

    it('posts an error when a file fails to download', async () => {
      fetchMock.mockImplementation(
        async (url: string) =>
          new Response(url.endsWith('.onnx') ? 'nope' : '1', {
            status: url.endsWith('.onnx') ? 404 : 200,
          }),
      );

      await post({ id: 2, mode: 'preload' });

      expect(postedMessages).toEqual([
        {
          id: 2,
          type: 'error',
          message: expect.stringContaining('Failed to download Whisper (404)'),
        },
      ]);
    });

    it('posts an error when the library names no runtime', async () => {
      // Downloading the weights alone would mark a step whose runtime then
      // downloads when the conversation starts.
      (env.backends.onnx.wasm as { wasmPaths?: unknown }).wasmPaths = undefined;

      await post({ id: 3, mode: 'preload' });

      expect(postedMessages).toEqual([
        {
          id: 3,
          type: 'error',
          message: expect.stringContaining('no ONNX Runtime files'),
        },
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
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

    await post({ id: 11, mode: 'load' });

    expect(postedMessages).toEqual([
      { id: 11, type: 'error', message: 'plain string failure' },
    ]);
  });
});
