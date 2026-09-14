import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRequest } from '#/lib/speech-to-text/messages';

const transcriberFn = vi.fn();
const pipelineFactory = vi.fn();

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => pipelineFactory(...args),
}));

let postedMessages: unknown[] = [];
let onmessage: ((event: MessageEvent<WorkerRequest>) => void) | undefined;

function post(request: WorkerRequest) {
  return onmessage?.({ data: request } as MessageEvent<WorkerRequest>);
}

beforeEach(async () => {
  postedMessages = [];
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

  it('builds the pipeline once across multiple messages', async () => {
    await post({ id: 4, mode: 'transcribe', audio: new Float32Array([0.1]) });
    await post({ id: 5, mode: 'transcribe', audio: new Float32Array([0.2]) });

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });

  it('answers a preload request once the pipeline is built', async () => {
    await post({ id: 6, mode: 'preload' });

    expect(postedMessages).toEqual([{ id: 6, type: 'done' }]);
  });

  it('forwards progress updates with the request id', async () => {
    pipelineFactory.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({
        status: 'progress',
        loaded: 10,
        total: 100,
        progress: 10,
      });
      return transcriberFn;
    });

    await post({ id: 8, mode: 'preload' });

    expect(postedMessages).toContainEqual({
      id: 8,
      type: 'progress',
      progress: { loaded: 10, total: 100, progress: 0.1 },
    });
  });

  it('ignores non-progress status updates', async () => {
    pipelineFactory.mockImplementation(async (_task, _model, options) => {
      options.progress_callback({ status: 'done' });
      return transcriberFn;
    });

    await post({ id: 9, mode: 'preload' });

    expect(postedMessages).toEqual([{ id: 9, type: 'done' }]);
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
