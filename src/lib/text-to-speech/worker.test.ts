import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerRequest } from '#/lib/text-to-speech/messages';

const stored = vi.fn();
const sessionCreate = vi.fn();

vi.mock('@mintplex-labs/piper-tts-web', () => ({
  stored: (...args: unknown[]) => stored(...args),
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
    postMessage: (msg: unknown) => postedMessages.push(msg),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });
  // The worker warms the browser's HTTP cache for the wasm runtime files
  // before every preload request — give it something to fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'Content-Length': '3' },
        }),
    ),
  );

  await import('#/lib/text-to-speech/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('worker onmessage', () => {
  it('answers a check request from stored() without creating a session', async () => {
    stored.mockResolvedValue(['voice-a', 'voice-b']);

    await post({ mode: 'check', voiceId: 'voice-a' });

    expect(postedMessages).toEqual([{ type: 'done', stored: true }]);
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it('reports false for a voice not in the stored list', async () => {
    stored.mockResolvedValue(['voice-b']);

    await post({ mode: 'check', voiceId: 'voice-a' });

    expect(postedMessages).toEqual([{ type: 'done', stored: false }]);
  });

  it('creates a session and reports done for a preload request', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ mode: 'preload', voiceId: 'voice-a' });

    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'voice-a' }),
    );
    expect(postedMessages.at(-1)).toEqual({ type: 'done' });
  });

  it('warms the wasm runtime cache before creating a session, reporting progress', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ mode: 'preload', voiceId: 'voice-a' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(postedMessages).toContainEqual({
      type: 'progress',
      progress: {
        url: expect.stringContaining('piper_phonemize.wasm'),
        loaded: 3,
        total: 3,
      },
    });
  });

  it('forwards session progress callbacks to postMessage', async () => {
    let capturedProgress: ((p: unknown) => void) | undefined;
    sessionCreate.mockImplementation(async (opts) => {
      capturedProgress = opts.progress;
      return { predict: vi.fn() };
    });

    await post({ mode: 'preload', voiceId: 'voice-a' });
    capturedProgress?.({ url: 'x', loaded: 1, total: 2 });

    expect(postedMessages).toContainEqual({
      type: 'progress',
      progress: { url: 'x', loaded: 1, total: 2 },
    });
  });

  it('predicts speech and posts the resulting audio buffer for a speak request', async () => {
    const wavBlob = new Blob(['wav bytes'], { type: 'audio/wav' });
    sessionCreate.mockResolvedValue({
      predict: vi.fn().mockResolvedValue(wavBlob),
    });

    await post({ mode: 'speak', voiceId: 'voice-a', text: 'hello' });

    expect(postedMessages).toHaveLength(1);
    const [message] = postedMessages as [
      { type: string; buffer: ArrayBuffer; mimeType: string },
    ];
    expect(message.type).toBe('done');
    expect(message.mimeType).toBe('audio/wav');
    expect(new TextDecoder().decode(message.buffer)).toBe('wav bytes');
  });

  it('posts an error message when session creation throws', async () => {
    sessionCreate.mockRejectedValue(new Error('boom'));

    await post({ mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([{ type: 'error', message: 'boom' }]);
  });

  it('stringifies non-Error throwables', async () => {
    stored.mockRejectedValue('plain string failure');

    await post({ mode: 'check', voiceId: 'voice-a' });

    expect(postedMessages).toEqual([
      { type: 'error', message: 'plain string failure' },
    ]);
  });
});
