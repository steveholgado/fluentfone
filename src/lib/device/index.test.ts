import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkDeviceSupport, hasWebGpu } from '#/lib/device';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('hasWebGpu', () => {
  it('is true when the browser exposes navigator.gpu', () => {
    vi.stubGlobal('navigator', { gpu: {} });

    expect(hasWebGpu()).toBe(true);
  });

  it('is false when it does not', () => {
    // Safari on macOS Sequoia, whatever its version: WebGPU is on by default
    // only from macOS Tahoe 26 / iOS 26.
    vi.stubGlobal('navigator', {});

    expect(hasWebGpu()).toBe(false);
  });
});

describe('checkDeviceSupport', () => {
  it('reports a WebGPU-capable device as supported with nothing unmet', async () => {
    vi.stubGlobal('navigator', { gpu: {} });

    const support = await checkDeviceSupport();

    expect(support.supported).toBe(true);
    expect(support.unmet).toEqual([]);
  });

  it('reports a device without WebGPU as unsupported', async () => {
    vi.stubGlobal('navigator', {});

    const support = await checkDeviceSupport();

    expect(support.supported).toBe(false);
    expect(support.unmet.map((r) => r.id)).toEqual(['webgpu']);
  });

  it('always reports every requirement, met or not', async () => {
    vi.stubGlobal('navigator', { gpu: {} });

    const support = await checkDeviceSupport();

    expect(support.results.map((r) => r.id)).toEqual(['webgpu']);
    expect(support.results.every((r) => r.met)).toBe(true);
  });

  it('treats a check that throws as unmet rather than rejecting', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('navigator', {
      get gpu(): never {
        throw new Error('blocked by policy');
      },
    });

    const support = await checkDeviceSupport();

    expect(support.supported).toBe(false);
    expect(support.unmet.map((r) => r.id)).toEqual(['webgpu']);
  });
});
