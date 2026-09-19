import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isJspiSupported,
  resolveRuntimeUrls,
  runtimeMarkerKey,
  selectRuntimeFileName,
} from '#/lib/chat/runtime';

const CDN = 'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.14.0/wasm';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('selectRuntimeFileName', () => {
  // The four builds @litert-lm/core picks between in its own load(). If this
  // drifts from theirs we prefetch one file and Engine.create() downloads a
  // different one — the silent multi-megabyte fetch this all exists to stop.
  it.each([
    [true, true, 'litertlm_wasm_internal.js'],
    [true, false, 'litertlm_wasm_asyncify_internal.js'],
    [false, true, 'litertlm_wasm_compat_internal.js'],
    [false, false, 'litertlm_wasm_compat_asyncify_internal.js'],
  ])('relaxedSimd=%s jspi=%s selects %s', (relaxedSimd, jspi, expected) => {
    expect(selectRuntimeFileName({ relaxedSimd, jspi })).toBe(expected);
  });
});

describe('resolveRuntimeUrls', () => {
  it('pairs the glue script with the wasm binary beside it', async () => {
    const urls = await resolveRuntimeUrls(CDN);

    expect(urls.js).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/.+\.js$/);
    expect(urls.wasm).toBe(urls.js.replace(/\.js$/, '.wasm'));
  });

  it('does not double the separator when the base already ends in a slash', async () => {
    const withSlash = await resolveRuntimeUrls(`${CDN}/`);
    const without = await resolveRuntimeUrls(CDN);

    expect(withSlash).toEqual(without);
    expect(withSlash.js).not.toContain('//litertlm');
  });

  it('only replaces the trailing .js, not an earlier one in the path', async () => {
    const urls = await resolveRuntimeUrls('https://example.com/a.js.d/wasm');

    expect(urls.wasm).toContain('/a.js.d/');
    expect(urls.wasm.endsWith('.wasm')).toBe(true);
  });
});

describe('runtimeMarkerKey', () => {
  it('carries the package version and the build variant', async () => {
    const key = await runtimeMarkerKey();

    // Version so a dependency bump invalidates the receipt; variant so a
    // browser that resolves a different build does too.
    expect(key).toMatch(/^litert:\d+\.\d+\.\d+:litertlm_wasm_.*\.js$/);
  });

  it('changes when the resolved build changes', async () => {
    vi.stubGlobal('WebAssembly', {
      ...WebAssembly,
      instantiate: vi.fn().mockResolvedValue({}),
    });
    const withRelaxedSimd = await runtimeMarkerKey();

    vi.stubGlobal('WebAssembly', {
      ...WebAssembly,
      instantiate: vi.fn().mockRejectedValue(new Error('unsupported')),
    });
    const withoutRelaxedSimd = await runtimeMarkerKey();

    expect(withRelaxedSimd).not.toBe(withoutRelaxedSimd);
  });
});

describe('isJspiSupported', () => {
  it('reports on the presence of WebAssembly.Suspending', () => {
    vi.stubGlobal('WebAssembly', { Suspending: class {} });
    expect(isJspiSupported()).toBe(true);

    vi.stubGlobal('WebAssembly', {});
    expect(isJspiSupported()).toBe(false);
  });
});
