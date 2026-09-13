import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as decode from '#/lib/audio/decode';

vi.mock('#/lib/audio/decode', () => ({
  toMonoPcm: vi.fn(),
}));

const transcriberFn = vi.fn();
const pipelineFactory = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineFactory(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decode.toMonoPcm).mockResolvedValue(new Float32Array([0.1]));

  pipelineFactory.mockResolvedValue(transcriberFn);
  transcriberFn.mockResolvedValue({ text: '  hello world  ' });

  vi.stubGlobal('navigator', {});
  vi.stubGlobal('caches', undefined);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('transcribe', () => {
  it('decodes the audio and returns the trimmed transcription text', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    const result = await transcribe(new Blob(['audio']));

    expect(result).toBe('hello world');
    expect(decode.toMonoPcm).toHaveBeenCalledWith(expect.any(Blob), 16000);
  });

  it('passes language and task options through to the pipeline call', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    await transcribe(new Blob(['audio']), {
      language: 'spanish',
      task: 'translate',
    });

    expect(transcriberFn).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ language: 'spanish', task: 'translate' }),
    );
  });

  it('defaults to the transcribe task', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    await transcribe(new Blob(['audio']));

    expect(transcriberFn).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ task: 'transcribe' }),
    );
  });

  it('handles an array result by using the first entry', async () => {
    transcriberFn.mockResolvedValue([{ text: 'first' }, { text: 'second' }]);
    const { transcribe } = await import('#/lib/speech-to-text/index');

    await expect(transcribe(new Blob(['audio']))).resolves.toBe('first');
  });

  it('returns an empty string when the result has no text', async () => {
    transcriberFn.mockResolvedValue({});
    const { transcribe } = await import('#/lib/speech-to-text/index');

    await expect(transcribe(new Blob(['audio']))).resolves.toBe('');
  });

  it('only builds the pipeline once across multiple calls', async () => {
    const { transcribe } = await import('#/lib/speech-to-text/index');

    await transcribe(new Blob(['a']));
    await transcribe(new Blob(['b']));

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });
});

describe('preload', () => {
  it('builds the pipeline and forwards progress updates', async () => {
    pipelineFactory.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({
        status: 'progress',
        loaded: 10,
        total: 100,
        progress: 10,
      });
      return transcriberFn;
    });

    const { preload } = await import('#/lib/speech-to-text/index');
    const onProgress = vi.fn();

    await preload(onProgress);

    expect(onProgress).toHaveBeenCalledWith({
      loaded: 10,
      total: 100,
      progress: 0.1,
    });
  });

  it('ignores non-progress status updates', async () => {
    pipelineFactory.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({ status: 'done' });
      return transcriberFn;
    });

    const { preload } = await import('#/lib/speech-to-text/index');
    const onProgress = vi.fn();

    await preload(onProgress);

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('isCached', () => {
  it('is true once the pipeline has been created in this session', async () => {
    const { preload, isCached } = await import('#/lib/speech-to-text/index');

    await preload();

    await expect(isCached()).resolves.toBe(true);
  });

  it('is false when there is no live pipeline and no Cache Storage', async () => {
    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
  });

  it('checks Cache Storage for at least two cached weight files', async () => {
    const keys = vi
      .fn()
      .mockResolvedValue([
        { url: 'https://cdn/onnx-community/whisper-base/encoder.onnx' },
        { url: 'https://cdn/onnx-community/whisper-base/decoder.onnx' },
        { url: 'https://cdn/other/file.onnx' },
      ]);

    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ keys }) });

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(true);
  });

  it('is false when fewer than two weight files are cached', async () => {
    const keys = vi
      .fn()
      .mockResolvedValue([
        { url: 'https://cdn/onnx-community/whisper-base/encoder.onnx' },
      ]);

    vi.stubGlobal('caches', { open: vi.fn().mockResolvedValue({ keys }) });

    const { isCached } = await import('#/lib/speech-to-text/index');

    await expect(isCached()).resolves.toBe(false);
  });
});
