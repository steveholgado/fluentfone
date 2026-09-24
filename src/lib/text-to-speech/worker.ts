import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest } from './messages';
import { ONNX_WASM_BASE, PIPER_WASM_BASE } from './constants';

// See the "why a fresh worker per call" comment in index.ts for why this
// worker gets terminated after every message it handles.

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

// This page isn't cross-origin isolated, so onnxruntime-web can't actually
// use multiple threads — it detects that itself and falls back to one, but
// only after piper-tts-web has already set numThreads to
// navigator.hardwareConcurrency, which makes onnxruntime-web log two
// spurious warnings on every session first. Reporting 1 here up front (this
// worker is disposable, so it doesn't affect anything else) skips that path
// and matches the single-threaded behavior we end up with anyway.
Object.defineProperty(self.navigator, 'hardwareConcurrency', { value: 1 });

// predict()'s `lengthScale` option comes from
// patches/@mintplex-labs__piper-tts-web@*.patch. It's typed here rather than
// in the patch so that losing the patch (say, on an upgrade) still builds:
// the unpatched predict() ignores the extra argument, and slow speech just
// plays at normal speed.
type PatchedSession = {
  predict(text: string, options?: { lengthScale?: number }): Promise<Blob>;
};

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const session = await TtsSession.create({
      voiceId: request.voiceId,
      wasmPaths: {
        ...TtsSession.WASM_LOCATIONS,
        onnxWasm: ONNX_WASM_BASE,
        piperWasm: `${PIPER_WASM_BASE}piper_phonemize.wasm`,
        piperData: `${PIPER_WASM_BASE}piper_phonemize.data`,
      },
    });

    if (request.mode === 'preload') {
      // The voice is now in OPFS and the wasm in the service worker's cache.
      // Nothing else to do — let this worker get terminated.
      ctx.postMessage({ type: 'done' });
      return;
    }

    const wav = await (session as PatchedSession).predict(request.text, {
      lengthScale: request.lengthScale,
    });

    // Transfer the underlying bytes rather than copying them.
    const buffer = await wav.arrayBuffer();
    ctx.postMessage({ type: 'done', buffer, mimeType: wav.type }, [buffer]);
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
