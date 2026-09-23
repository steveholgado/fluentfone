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
  it('creates a session and reports done for a preload request', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ mode: 'preload', voiceId: 'voice-a' });

    expect(sessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'voice-a' }),
    );
    expect(postedMessages.at(-1)).toEqual({ type: 'done' });
  });

  it('points the session at the self-hosted wasm rather than the CDN', async () => {
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ mode: 'preload', voiceId: 'voice-a' });

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
    sessionCreate.mockRejectedValue('plain string failure');

    await post({ mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { type: 'error', message: 'plain string failure' },
    ]);
  });
});
