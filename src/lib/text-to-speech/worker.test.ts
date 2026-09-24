import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRequest } from '#/lib/text-to-speech/messages';

const sessionCreate = vi.fn();

vi.mock('@mintplex-labs/piper-tts-web', () => ({
  TtsSession: {
    WASM_LOCATIONS: { base: 'https://example.com/wasm/' },
    create: (...args: unknown[]) => sessionCreate(...args),
  },
}));

let postedMessages: unknown[] = [];
let onmessage: ((event: MessageEvent<WorkerRequest>) => void) | undefined;

function post(request: WorkerRequest) {
  return onmessage?.({ data: request } as MessageEvent<WorkerRequest>);
}

beforeEach(async () => {
  postedMessages = [];
  vi.stubGlobal('self', {
    navigator: { hardwareConcurrency: 8 },
    postMessage: (msg: unknown) => postedMessages.push(msg),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });
  await import('#/lib/text-to-speech/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('worker onmessage', () => {
  it('creates a session and reports done for a load request', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });

    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'voice-a' }),
    );
    expect(postedMessages).toEqual([{ id: 0, type: 'done' }]);
  });

  it('points the session at the self-hosted wasm rather than the CDN', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });

    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        wasmPaths: expect.objectContaining({
          onnxWasm: expect.stringContaining('/vendor/onnx/'),
          piperWasm: expect.stringContaining('/vendor/piper-wasm/'),
          piperData: expect.stringContaining('/vendor/piper-wasm/'),
        }),
      }),
    );
  });

  it('predicts speech and posts the resulting audio buffer for a speak request', async () => {
    const wavBlob = new Blob(['wav bytes'], { type: 'audio/wav' });
    sessionCreate.mockResolvedValue({
      predict: vi.fn().mockResolvedValue(wavBlob),
    });

    await post({ id: 3, mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(postedMessages).toHaveLength(1);
    const [message] = postedMessages as [
      { id: number; type: string; buffer: ArrayBuffer; mimeType: string },
    ];
    expect(message.id).toBe(3);
    expect(message.type).toBe('done');
    expect(message.mimeType).toBe('audio/wav');
    expect(new TextDecoder().decode(message.buffer)).toBe('wav bytes');
  });

  it('keeps one session for every request, loaded once', async () => {
    const predict = vi.fn().mockResolvedValue(new Blob(['wav']));
    sessionCreate.mockResolvedValue({ predict });

    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'uno' });
    await post({ id: 2, mode: 'speak', voiceId: 'voice-a', text: 'dos' });

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(predict).toHaveBeenCalledTimes(2);
  });

  it('synthesises one line at a time, in the order they arrived', async () => {
    // A reply's next sentence is sent while the last is still synthesising,
    // and ORT won't run one session twice at once.
    let finishFirst!: (wav: Blob) => void;
    const predict = vi
      .fn()
      .mockReturnValueOnce(new Promise<Blob>((res) => (finishFirst = res)))
      .mockResolvedValueOnce(new Blob(['dos']));
    sessionCreate.mockResolvedValue({ predict });

    const first = post({
      id: 0,
      mode: 'speak',
      voiceId: 'voice-a',
      text: 'uno',
    });
    const second = post({
      id: 1,
      mode: 'speak',
      voiceId: 'voice-a',
      text: 'dos',
    });
    await vi.waitFor(() => expect(predict).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(predict).toHaveBeenCalledTimes(1);

    finishFirst(new Blob(['uno']));
    await Promise.all([first, second]);

    expect(predict.mock.calls.map(([text]) => text)).toEqual(['uno', 'dos']);
    expect(postedMessages.map((m) => (m as { id: number }).id)).toEqual([0, 1]);
  });

  it('keeps going after a line fails', async () => {
    const predict = vi
      .fn()
      .mockRejectedValueOnce(new Error('synth failed'))
      .mockResolvedValueOnce(new Blob(['dos']));
    sessionCreate.mockResolvedValue({ predict });

    await post({ id: 0, mode: 'speak', voiceId: 'voice-a', text: 'uno' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'dos' });

    expect(postedMessages).toEqual([
      { id: 0, type: 'error', message: 'synth failed' },
      expect.objectContaining({ id: 1, type: 'done' }),
    ]);
  });

  it('refuses a second voice rather than speaking with the first', async () => {
    // piper-tts-web's singleton would hand back voice-a's session relabelled.
    sessionCreate.mockResolvedValue({ predict: vi.fn() });
    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });

    await post({ id: 1, mode: 'speak', voiceId: 'voice-b', text: 'hola' });

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(postedMessages.at(-1)).toEqual({
      id: 1,
      type: 'error',
      message: expect.stringContaining('voice-b needs a worker of its own'),
    });
  });

  it('keeps a failed load failed rather than retrying it', async () => {
    // Piper keeps the broken instance as its singleton, so a retry would only
    // be handed it back. The main thread replaces the worker instead.
    sessionCreate.mockRejectedValueOnce(new Error('boom'));

    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(sessionCreate).toHaveBeenCalledTimes(1);
    expect(postedMessages).toEqual([
      { id: 0, type: 'error', message: 'boom' },
      { id: 1, type: 'error', message: 'boom' },
    ]);
  });

  it('reports how long predict took', async () => {
    sessionCreate.mockResolvedValue({
      predict: vi.fn().mockResolvedValue(new Blob(['wav'])),
    });
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(1700);

    await post({ id: 0, mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(postedMessages[0]).toMatchObject({ synthesisMs: 1500 });
    now.mockRestore();
  });

  it('passes lengthScale through to predict', async () => {
    const predict = vi.fn().mockResolvedValue(new Blob(['wav']));
    sessionCreate.mockResolvedValue({ predict });

    await post({
      id: 0,
      mode: 'speak',
      voiceId: 'voice-a',
      text: 'hello',
      lengthScale: 1.5,
    });

    expect(predict).toHaveBeenCalledWith('hello', { lengthScale: 1.5 });
  });

  it('leaves lengthScale unset for normal-speed speech', async () => {
    const predict = vi.fn().mockResolvedValue(new Blob(['wav']));
    sessionCreate.mockResolvedValue({ predict });

    await post({ id: 0, mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(predict).toHaveBeenCalledWith('hello', { lengthScale: undefined });
  });

  it('posts an error message when predict throws', async () => {
    sessionCreate.mockResolvedValue({
      predict: vi.fn().mockRejectedValue(new Error('synth failed')),
    });

    await post({ id: 4, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { id: 4, type: 'error', message: 'synth failed' },
    ]);
  });

  it('stringifies non-Error throwables', async () => {
    sessionCreate.mockRejectedValue('plain string failure');

    await post({ id: 5, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { id: 5, type: 'error', message: 'plain string failure' },
    ]);
  });
});
