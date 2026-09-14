import { TtsSession, stored } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest } from './messages';

// See the "why a fresh worker per call" comment in index.ts for why this
// worker gets terminated after every message it handles.
//
// Self-hosted wasm/data files, vendored from node_modules at dev/build time
// by vite-plugin-vendor-wasm-assets.ts, instead of piper-tts-web's default
// of fetching them from jsDelivr/cdnjs at runtime.
const ONNX_WASM_BASE = '/vendor/onnx/1.23.2/';
const PIPER_WASM_BASE = '/vendor/piper-wasm/1.0.0/';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    // Answer before touching TtsSession — creating one would download the
    // voice, which is exactly what this request is asking about.
    if (request.mode === 'check') {
      const voices = await stored();
      ctx.postMessage({
        type: 'done',
        stored: voices.includes(request.voiceId),
      });
      return;
    }

    const session = await TtsSession.create({
      voiceId: request.voiceId,
      progress: (progress) => {
        ctx.postMessage({ type: 'progress', progress });
      },
      wasmPaths: {
        ...TtsSession.WASM_LOCATIONS,
        onnxWasm: ONNX_WASM_BASE,
        piperWasm: `${PIPER_WASM_BASE}piper_phonemize.wasm`,
        piperData: `${PIPER_WASM_BASE}piper_phonemize.data`,
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
