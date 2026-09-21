import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest } from './messages';
import { ONNX_WASM_BASE, PIPER_WASM_BASE } from './constants';

// See the "why a fresh worker per call" comment in index.ts for why this
// worker gets terminated after every message it handles.

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

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

    const wav = await session.predict(request.text);

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
