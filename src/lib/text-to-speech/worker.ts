import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest, WorkerResponse } from './messages';
import { ONNX_WASM_BASE, PIPER_WASM_BASE } from './constants';

// One voice per worker, for the worker's whole life — see the comment at the
// top of index.ts for why.

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

// This page isn't cross-origin isolated, so onnxruntime-web can't actually
// use multiple threads — it detects that itself and falls back to one, but
// only after piper-tts-web has already set numThreads to
// navigator.hardwareConcurrency, which makes onnxruntime-web log two
// spurious warnings on every session first. Reporting 1 here up front (this
// worker only ever runs piper, so it doesn't affect anything else) skips that
// path and matches the single-threaded behavior we end up with anyway.
Object.defineProperty(self.navigator, 'hardwareConcurrency', { value: 1 });

// predict()'s `lengthScale` option comes from
// patches/@mintplex-labs__piper-tts-web@*.patch. It's typed here rather than
// in the patch so that losing the patch (say, on an upgrade) still builds:
// the unpatched predict() ignores the extra argument, and slow speech just
// plays at normal speed.
type PatchedSession = {
  predict(text: string, options?: { lengthScale?: number }): Promise<Blob>;
};

let session: Promise<PatchedSession> | null = null;
let sessionVoiceId: string | null = null;

/**
 * The worker's one session, created on first use. Refuses a second voice
 * rather than handing back the first one's session, which is what
 * piper-tts-web's singleton would otherwise do without a word.
 *
 * A failed creation is kept, not retried: piper records its singleton in the
 * constructor, before loading, so a retry here would only be handed the same
 * broken instance back. The main thread replaces the worker instead.
 */
function getSession(voiceId: string): Promise<PatchedSession> {
  if (sessionVoiceId !== null && sessionVoiceId !== voiceId) {
    return Promise.reject(
      new Error(
        `This worker speaks ${sessionVoiceId}; ${voiceId} needs a worker of its own.`,
      ),
    );
  }

  sessionVoiceId = voiceId;
  session ??= TtsSession.create({
    voiceId,
    wasmPaths: {
      ...TtsSession.WASM_LOCATIONS,
      onnxWasm: ONNX_WASM_BASE,
      piperWasm: `${PIPER_WASM_BASE}piper_phonemize.wasm`,
      piperData: `${PIPER_WASM_BASE}piper_phonemize.data`,
    },
  });

  return session;
}

// Lines are synthesised one at a time, in the order they arrived. A caller can
// send the next line before the last has finished — a reply is spoken sentence
// by sentence as it's generated — and ORT won't run one session twice at once.
let queue: Promise<unknown> = Promise.resolve();

function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id } = request;

  try {
    const voice = await getSession(request.voiceId);

    if (request.mode === 'load') {
      ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
      return;
    }

    const { wav, synthesisMs } = await inTurn(async () => {
      const synthesisStart = performance.now();
      const wav = await voice.predict(request.text, {
        lengthScale: request.lengthScale,
      });
      return { wav, synthesisMs: performance.now() - synthesisStart };
    });

    // Transfer the underlying bytes rather than copying them.
    const buffer = await wav.arrayBuffer();
    ctx.postMessage(
      {
        id,
        type: 'done',
        buffer,
        mimeType: wav.type,
        synthesisMs,
      } satisfies WorkerResponse,
      [buffer],
    );
  } catch (err) {
    ctx.postMessage({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
