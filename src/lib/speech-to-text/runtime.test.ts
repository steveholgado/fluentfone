import { describe, expect, it } from 'vitest';

import { resolveOrtRuntimeUrls } from '#/lib/speech-to-text/runtime';

const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';

describe('resolveOrtRuntimeUrls', () => {
  it('takes the object form as given, without second-guessing the build', () => {
    // This is the shape Transformers.js actually sets, so its own choice of
    // build passes through untouched.
    const urls = resolveOrtRuntimeUrls(
      {
        mjs: `${CDN}ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${CDN}x.wasm`,
      },
      false,
    );

    expect(urls).toEqual({
      mjs: `${CDN}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${CDN}x.wasm`,
    });
  });

  it('mirrors the asyncify build off Safari when given a prefix', () => {
    const urls = resolveOrtRuntimeUrls(CDN, false);

    expect(urls).toEqual({
      mjs: `${CDN}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${CDN}ort-wasm-simd-threaded.asyncify.wasm`,
    });
  });

  it('mirrors the plain build on Safari when given a prefix', () => {
    const urls = resolveOrtRuntimeUrls(CDN, true);

    expect(urls).toEqual({
      mjs: `${CDN}ort-wasm-simd-threaded.mjs`,
      wasm: `${CDN}ort-wasm-simd-threaded.wasm`,
    });
  });

  it('adds the separator to a prefix that lacks one', () => {
    const urls = resolveOrtRuntimeUrls(CDN.slice(0, -1), true);

    expect(urls?.wasm).toBe(`${CDN}ort-wasm-simd-threaded.wasm`);
  });

  it.each([
    ['unset', undefined],
    ['null', null],
    ['a half-filled object', { mjs: 'only-this.mjs' }],
    ['the wrong type', 42],
  ])('returns null when wasmPaths is %s', (_label, value) => {
    // Better to skip the warm than to guess at a URL: a wrong guess downloads
    // tens of megabytes that nothing will ever read.
    expect(resolveOrtRuntimeUrls(value, false)).toBeNull();
  });
});
