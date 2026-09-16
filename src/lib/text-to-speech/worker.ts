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

// The wasm runtimes TtsSession.create() fetches internally, in the same
// versioned locations it's pointed at below. piper-tts-web never reports
// progress for these (only for the voice model itself), so on a genuinely
// first-ever load — several MB, comparable to the voice model — the
// progress bar would sit frozen through this whole phase. Fetching them
// ourselves first, with progress, warms the browser's HTTP cache (they're
// served `immutable`, see public/_headers) so TtsSession.create()'s own
// fetch of the same URLs resolves from disk instead of the network.
const WASM_FILES = [
  `${ONNX_WASM_BASE}ort-wasm-simd-threaded.wasm`,
  `${PIPER_WASM_BASE}piper_phonemize.wasm`,
  `${PIPER_WASM_BASE}piper_phonemize.data`,
];

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage's transfer-list overload.
const ctx = self as unknown as Worker;

/** Fetches a URL, reporting byte progress, so its response lands in the HTTP cache. */
async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) return;

  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    loaded += value.byteLength;
    onProgress(loaded, total || loaded);
  }
}

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

    if (request.mode === 'preload') {
      await Promise.all(
        WASM_FILES.map((url) =>
          fetchWithProgress(url, (loaded, total) => {
            ctx.postMessage({
              type: 'progress',
              progress: { url, loaded, total },
            });
          }),
        ),
      );
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
