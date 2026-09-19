/**
 * Shared between the main thread (which probes for the receipt during the
 * check stage) and worker.ts (which writes it during preload), so the key is
 * only spelled once.
 *
 * Transformers.js bundles its own copy of onnxruntime-web — a different,
 * newer pin than the `onnxruntime-web` in package.json, which exists only as
 * piper-tts-web's peer. Only the ORT *JavaScript* is bundled; the wasm binary
 * is resolved by URL at run time, which is why it needs prefetching at all.
 *
 * The version is left out of the key on purpose: reading it means reading
 * `env.backends.onnx.versions.web`, which only exists once the 500 KB
 * Transformers.js chunk has loaded — and the check stage must not load it.
 * Bumping @huggingface/transformers can therefore leave a stale receipt; the
 * cost is one silent re-download on the next visit after the bump, which the
 * `onStage` reporting in useConversation surfaces rather than hides.
 */
export const ORT_RUNTIME_MARKER_KEY = 'ort-runtime';

/** The two files ORT loads at run time: the emscripten glue and its binary. */
export interface OrtRuntimeUrls {
  mjs: string;
  wasm: string;
}

/**
 * Reads back the paths Transformers.js has already resolved, rather than
 * rebuilding them.
 *
 * Transformers.js populates `env.backends.onnx.wasm.wasmPaths` at import time
 * and only when unset, branching between the plain and `asyncify` builds on
 * Safari. Reading the value it settled on keeps that branching in one place —
 * theirs — so a change to it can't silently leave us prefetching the wrong
 * pair of files.
 *
 * `wasmPaths` is typed as a prefix string *or* a per-file object, so both
 * shapes are handled. Returns null if it is unset or partial, in which case
 * the caller should skip the warm rather than guess.
 */
export function resolveOrtRuntimeUrls(
  wasmPaths: unknown,
  isSafari: boolean,
): OrtRuntimeUrls | null {
  if (typeof wasmPaths === 'string') {
    const base = wasmPaths.endsWith('/') ? wasmPaths : `${wasmPaths}/`;
    // Mirrors Transformers.js' own choice of build for the prefix form.
    const stem = isSafari
      ? 'ort-wasm-simd-threaded'
      : 'ort-wasm-simd-threaded.asyncify';
    return { mjs: `${base}${stem}.mjs`, wasm: `${base}${stem}.wasm` };
  }

  if (wasmPaths && typeof wasmPaths === 'object') {
    const { mjs, wasm } = wasmPaths as { mjs?: unknown; wasm?: unknown };
    if (typeof mjs === 'string' && typeof wasm === 'string') {
      return { mjs, wasm };
    }
  }

  return null;
}
