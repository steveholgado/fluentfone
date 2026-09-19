import { TtsSession } from '@mintplex-labs/piper-tts-web';
import type { WorkerRequest } from './messages';
import { warmRuntime } from '../runtime-cache';
import {
  ONNX_WASM_BASE,
  PIPER_RUNTIME_MARKER_KEY,
  PIPER_WASM_BASE,
  WASM_FILES,
} from './runtime';

// See the "why a fresh worker per call" comment in index.ts for why this
// worker gets terminated after every message it handles.

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    // Its own step rather than a prelude to 'preload', so the wasm bytes and
    // the voice bytes each get a progress bar that runs start to finish. Run
    // together they'd share one, and the total would jump when the voice
    // download began.
    if (request.mode === 'runtime') {
      await warmRuntime(WASM_FILES, PIPER_RUNTIME_MARKER_KEY, (progress) => {
        ctx.postMessage({
          type: 'progress',
          progress: {
            url: 'piper-runtime',
            loaded: progress.loaded,
            total: progress.total ?? progress.loaded,
          },
        });
      });
      ctx.postMessage({ type: 'done' });
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
