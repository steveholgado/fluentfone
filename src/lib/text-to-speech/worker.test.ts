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
    postMessage: (msg: unknown) => postedMessages.push(msg),
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
  });
  // A 'runtime' request warms the browser's HTTP cache for the wasm files —
  // give it something to fetch.
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
  // warmRuntime writes a receipt on success; the worker shouldn't care
  // whether Cache Storage exists.
  vi.stubGlobal('caches', undefined);

  await import('#/lib/text-to-speech/worker');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('worker onmessage', () => {
  it('downloads the wasm runtime files without creating a session', async () => {
    await post({ mode: 'runtime' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sessionCreate).not.toHaveBeenCalled();
    expect(postedMessages.at(-1)).toEqual({ type: 'done' });
  });

  it('reports one combined progress figure across the runtime files', async () => {
    await post({ mode: 'runtime' });

    // Summed across all three files rather than reported per-file, so the
    // bar moves forward once instead of restarting three times.
    expect(postedMessages).toContainEqual({
      type: 'progress',
      progress: { url: 'piper-runtime', loaded: 9, total: 9 },
    });
  });

  it('does not download the runtime again as part of a preload request', async () => {
    // The two are separate steps so each gets its own progress sweep; folding
    // the wasm back into 'preload' would make the voice download share a bar
    // that had already reached 100%.
    sessionCreate.mockResolvedValue({ predict: vi.fn() });

    await post({ mode: 'preload', voiceId: 'voice-a' });

    expect(fetch).not.toHaveBeenCalled();
  });

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
    sessionCreate.mockRejectedValue('plain string failure');

    await post({ mode: 'speak', voiceId: 'voice-a', text: 'hi' });

    expect(postedMessages).toEqual([
      { type: 'error', message: 'plain string failure' },
    ]);
  });
});
