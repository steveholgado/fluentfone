import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest } from './messages';

// See the "why a fresh worker per call" comment in index.ts for why this
// worker gets terminated after every message it handles.
const ONNX_WASM_BASE =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    const session = await TtsSession.create({
      voiceId: request.voiceId,
      progress: (progress) => {
        ctx.postMessage({ type: 'progress', progress });
      },
      wasmPaths: {
        ...TtsSession.WASM_LOCATIONS,
        onnxWasm: ONNX_WASM_BASE,
      },
    });

    if (request.mode === 'preload') {
      // Model + wasm are now downloaded and cached by the browser. Nothing
      // else to do — let this worker get terminated.
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
