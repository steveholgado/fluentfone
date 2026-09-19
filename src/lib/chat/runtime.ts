/**
 * Works out which LiteRT-LM wasm runtime this browser will load, so it can be
 * prefetched during the preload stage instead of landing silently mid-
 * conversation.
 *
 * LiteRT-LM ships four builds and picks between them by feature detection at
 * `Engine.create()` time. That selection lives in the package's
 * `dist/wasm_feature_detect.js` and `dist/load.js`, but its package.json
 * `exports` map has no `./dist/*` wildcard, so neither can be imported — the
 * same wall `vite-plugin-vendor-wasm-assets.ts` documents for
 * onnxruntime-web. The two checks are reproduced here instead; they must stay
 * in step with that package's `load()`, so both are pinned by the test suite.
 *
 * The CDN base is *not* reproduced — it's read from the library's own
 * `DEFAULT_WASM_PATH`, so a dependency bump moves these URLs automatically and
 * no version string is duplicated into this codebase.
 */

// The only part of @litert-lm/core this module is allowed to pull in. The
// check stage calls runtimeMarkerKey() and must not drag the library's code
// (or its 20 MB of wasm) along with it, so the version comes from the
// package's manifest — which its `exports` map does expose — rather than from
// `DEFAULT_WASM_PATH`, which would require importing the library itself.
import { version as LITERT_VERSION } from '@litert-lm/core/package.json';

/**
 * A 38-byte module using `i8x16.relaxed_swizzle`, copied verbatim from
 * LiteRT-LM's `WASM_RELAXED_SIMD_CHECK`. It instantiates only where relaxed
 * SIMD is available.
 */
const WASM_RELAXED_SIMD_CHECK = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1,
  13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
]);

/** File names LiteRT-LM chooses between, mirroring its `load.js`. */
const WASM_JS_FILE_NAME = 'litertlm_wasm_internal.js';
const WASM_JS_COMPAT_FILE_NAME = 'litertlm_wasm_compat_internal.js';
const WASM_JS_ASYNCIFY_FILE_NAME = 'litertlm_wasm_asyncify_internal.js';
const WASM_JS_COMPAT_ASYNCIFY_FILE_NAME =
  'litertlm_wasm_compat_asyncify_internal.js';

export interface LiteRtRuntimeFeatures {
  relaxedSimd: boolean;
  jspi: boolean;
}

/** The glue script and the wasm binary that sits beside it. */
export interface LiteRtRuntimeUrls {
  js: string;
  wasm: string;
}

export async function detectFeatures(): Promise<LiteRtRuntimeFeatures> {
  return {
    relaxedSimd: await supportsRelaxedSimd(),
    jspi: isJspiSupported(),
  };
}

/** Mirrors the file selection in `@litert-lm/core`'s `load()`. */
export function selectRuntimeFileName({
  relaxedSimd,
  jspi,
}: LiteRtRuntimeFeatures): string {
  if (relaxedSimd) {
    return jspi ? WASM_JS_FILE_NAME : WASM_JS_ASYNCIFY_FILE_NAME;
  }
  return jspi ? WASM_JS_COMPAT_FILE_NAME : WASM_JS_COMPAT_ASYNCIFY_FILE_NAME;
}

/**
 * Resolves the runtime URLs this browser will actually load. `basePath` is the
 * library's `LiteRtLm.DEFAULT_WASM_PATH`, passed in by the caller so this
 * module stays free of any dynamic import.
 */
export async function resolveRuntimeUrls(
  basePath: string,
): Promise<LiteRtRuntimeUrls> {
  const fileName = selectRuntimeFileName(await detectFeatures());
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;

  return {
    js: `${base}${fileName}`,
    wasm: `${base}${fileName.replace(/\.js$/, '.wasm')}`,
  };
}

/**
 * Cache-receipt key for the runtime this browser would load. Carries both the
 * package version and the build variant, so bumping the dependency — or
 * running on a browser whose wasm features differ from last time — invalidates
 * the old receipt rather than matching it.
 *
 * Deliberately computable without loading the library, so the check stage can
 * call it.
 */
export async function runtimeMarkerKey(): Promise<string> {
  const fileName = selectRuntimeFileName(await detectFeatures());
  return `litert:${LITERT_VERSION}:${fileName}`;
}

/** Returns true if JSPI is supported, matching LiteRT-LM's own check. */
export function isJspiSupported(): boolean {
  return 'Suspending' in WebAssembly;
}

async function supportsRelaxedSimd(): Promise<boolean> {
  try {
    await WebAssembly.instantiate(WASM_RELAXED_SIMD_CHECK);
    return true;
  } catch {
    return false;
  }
}
