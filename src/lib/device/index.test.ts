import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/**
 * HAS_WEBGPU is read when the module loads, so each test stubs `navigator`
 * first and then imports a fresh copy.
 */
async function loadWith(navigatorStub: object) {
  vi.stubGlobal('navigator', navigatorStub);
  vi.resetModules();
  return import('#/lib/device');
}

describe('HAS_WEBGPU', () => {
  it('is true when the browser exposes navigator.gpu', async () => {
    const { HAS_WEBGPU } = await loadWith({ gpu: {} });

    expect(HAS_WEBGPU).toBe(true);
  });

  it('is false when it does not', async () => {
    // Safari on macOS Sequoia, whatever its version: WebGPU is on by default
    // only from macOS Tahoe 26 / iOS 26.
    const { HAS_WEBGPU } = await loadWith({});

    expect(HAS_WEBGPU).toBe(false);
  });

  it('is false, rather than failing the import, when navigator.gpu throws', async () => {
    const { HAS_WEBGPU } = await loadWith({
      get gpu(): never {
        throw new Error('blocked by policy');
      },
    });

    expect(HAS_WEBGPU).toBe(false);
  });
});

describe('supportsShaderF16', () => {
  const adapterWith = (...features: string[]) => ({
    features: new Set(features),
  });

  it('is true when the adapter has shader-f16', async () => {
    const { supportsShaderF16 } = await loadWith({
      gpu: { requestAdapter: async () => adapterWith('shader-f16') },
    });

    await expect(supportsShaderF16()).resolves.toBe(true);
  });

  it('is false when the adapter does not', async () => {
    const { supportsShaderF16 } = await loadWith({
      gpu: { requestAdapter: async () => adapterWith('timestamp-query') },
    });

    await expect(supportsShaderF16()).resolves.toBe(false);
  });

  it('is false when there is no adapter to be had', async () => {
    const { supportsShaderF16 } = await loadWith({
      gpu: { requestAdapter: async () => null },
    });

    await expect(supportsShaderF16()).resolves.toBe(false);
  });

  it('is false, rather than rejecting, when asking for an adapter throws', async () => {
    const { supportsShaderF16 } = await loadWith({
      gpu: {
        requestAdapter: async () => {
          throw new Error('GPU process crashed');
        },
      },
    });

    await expect(supportsShaderF16()).resolves.toBe(false);
  });

  it('is false without WebGPU', async () => {
    const { supportsShaderF16 } = await loadWith({});

    await expect(supportsShaderF16()).resolves.toBe(false);
  });

  it('asks for an adapter only once', async () => {
    const requestAdapter = vi.fn(async () => adapterWith('shader-f16'));
    const { supportsShaderF16 } = await loadWith({ gpu: { requestAdapter } });

    await supportsShaderF16();
    await supportsShaderF16();

    expect(requestAdapter).toHaveBeenCalledOnce();
  });
});

describe('checkDeviceSupport', () => {
  it('reports a WebGPU-capable device as supported with nothing unmet', async () => {
    const { checkDeviceSupport } = await loadWith({ gpu: {} });

    const support = await checkDeviceSupport();

    expect(support.supported).toBe(true);
    expect(support.unmet).toEqual([]);
  });

  it('reports a device without WebGPU as unsupported', async () => {
    const { checkDeviceSupport } = await loadWith({});

    const support = await checkDeviceSupport();

    expect(support.supported).toBe(false);
    expect(support.unmet.map((r) => r.id)).toEqual(['webgpu']);
  });

  it('always reports every requirement, met or not', async () => {
    const { checkDeviceSupport } = await loadWith({ gpu: {} });

    const support = await checkDeviceSupport();

    expect(support.results.map((r) => r.id)).toEqual(['webgpu']);
    expect(support.results.every((r) => r.met)).toBe(true);
  });
});
