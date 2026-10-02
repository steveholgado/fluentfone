import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRequest } from '#/lib/text-to-speech/messages';
import type { PiperVoice } from '#/lib/text-to-speech/piper';

const loadVoice = vi.fn();
const synthesize = vi.fn();
const toWav = vi.fn();

vi.mock('#/lib/text-to-speech/piper', () => ({
  loadVoice: (...args: unknown[]) => loadVoice(...args),
  synthesize: (...args: unknown[]) => synthesize(...args),
  toWav: (...args: unknown[]) => toWav(...args),
}));

const VOICE = {
  config: { audio: { sample_rate: 22050 } },
} as unknown as PiperVoice;

const SAMPLES = new Float32Array([0.1, -0.1]);

/** A fresh buffer per call, since each one is transferred away. */
function wavOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

let postedMessages: unknown[] = [];
let onmessage: ((event: MessageEvent<WorkerRequest>) => void) | undefined;

function post(request: WorkerRequest) {
  return onmessage?.({ data: request } as MessageEvent<WorkerRequest>);
}

beforeEach(async () => {
  postedMessages = [];
  loadVoice.mockResolvedValue(VOICE);
  synthesize.mockResolvedValue(SAMPLES);
  toWav.mockImplementation(() => wavOf('wav bytes'));
  vi.stubGlobal('self', {
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
  vi.resetAllMocks();
});

describe('worker onmessage', () => {
  it('loads the voice and reports done for a load request', async () => {
    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });

    expect(loadVoice).toHaveBeenCalledWith('voice-a');
    expect(postedMessages).toEqual([{ id: 0, type: 'done' }]);
  });

  it('synthesises a line and posts it as WAV bytes for a speak request', async () => {
    await post({ id: 3, mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(synthesize).toHaveBeenCalledWith(VOICE, 'hello', undefined);
    expect(toWav).toHaveBeenCalledWith(SAMPLES, 22050);
    expect(postedMessages).toHaveLength(1);
    const [message] = postedMessages as [
      { id: number; type: string; buffer: ArrayBuffer; mimeType: string },
    ];
    expect(message.id).toBe(3);
    expect(message.type).toBe('done');
    expect(message.mimeType).toBe('audio/wav');
    expect(new TextDecoder().decode(message.buffer)).toBe('wav bytes');
  });

  it('keeps one voice for every request, loaded once', async () => {
    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'uno' });
    await post({ id: 2, mode: 'speak', voiceId: 'voice-a', text: 'dos' });

    expect(loadVoice).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it('synthesises one line at a time, in the order they arrived', async () => {
    // A reply's next sentence is sent while the last is still synthesising,
    // and ORT won't run one session twice at once.
    let finishFirst!: (samples: Float32Array) => void;
    synthesize
      .mockReturnValueOnce(
        new Promise<Float32Array>((res) => (finishFirst = res)),
      )
      .mockResolvedValueOnce(SAMPLES);

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
    await vi.waitFor(() => expect(synthesize).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(synthesize).toHaveBeenCalledTimes(1);

    finishFirst(SAMPLES);
    await Promise.all([first, second]);

    expect(synthesize.mock.calls.map(([, text]) => text)).toEqual([
      'uno',
      'dos',
    ]);
    expect(postedMessages.map((m) => (m as { id: number }).id)).toEqual([0, 1]);
  });

  it('keeps going after a line fails', async () => {
    synthesize
      .mockRejectedValueOnce(new Error('synth failed'))
      .mockResolvedValueOnce(SAMPLES);

    await post({ id: 0, mode: 'speak', voiceId: 'voice-a', text: 'uno' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'dos' });

    expect(postedMessages).toEqual([
      { id: 0, type: 'error', message: 'synth failed' },
      expect.objectContaining({ id: 1, type: 'done' }),
    ]);
  });

  it('refuses a second voice rather than speaking with the first', async () => {
    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });

    await post({ id: 1, mode: 'speak', voiceId: 'voice-b', text: 'hola' });

    expect(loadVoice).toHaveBeenCalledTimes(1);
    expect(synthesize).not.toHaveBeenCalled();
    expect(postedMessages.at(-1)).toEqual({
      id: 1,
      type: 'error',
      message: expect.stringContaining('voice-b needs a worker of its own'),
    });
  });

  it('tries a failed load again on the next request', async () => {
    loadVoice.mockRejectedValueOnce(new Error('offline'));

    await post({ id: 0, mode: 'load', voiceId: 'voice-a' });
    await post({ id: 1, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(loadVoice).toHaveBeenCalledTimes(2);
    expect(postedMessages).toEqual([
      { id: 0, type: 'error', message: 'offline' },
      expect.objectContaining({ id: 1, type: 'done' }),
    ]);
  });

  it('reports how long synthesis took', async () => {
    const now = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(1700);

    await post({ id: 0, mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(postedMessages[0]).toMatchObject({ synthesisMs: 1500 });
    now.mockRestore();
  });

  it('passes lengthScale through to synthesis', async () => {
    await post({
      id: 0,
      mode: 'speak',
      voiceId: 'voice-a',
      text: 'hello',
      lengthScale: 1.5,
    });

    expect(synthesize).toHaveBeenCalledWith(VOICE, 'hello', 1.5);
  });

  it('posts an error message when synthesis throws', async () => {
    synthesize.mockRejectedValue(new Error('synth failed'));

    await post({ id: 4, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { id: 4, type: 'error', message: 'synth failed' },
    ]);
  });

  it('stringifies non-Error throwables', async () => {
    loadVoice.mockRejectedValue('plain string failure');

    await post({ id: 5, mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { id: 5, type: 'error', message: 'plain string failure' },
    ]);
  });
});
