import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The module memoizes its answer, so every test imports it fresh.
 */
async function load() {
  return import('#/lib/sw-client');
}

interface FakeContainer {
  controller: unknown;
  register: ReturnType<typeof vi.fn>;
  ready: Promise<unknown>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

let container: FakeContainer;
let listeners: Map<string, () => void>;

function stubServiceWorker(overrides: Partial<FakeContainer> = {}) {
  listeners = new Map();

  container = {
    controller: null,
    register: vi.fn().mockResolvedValue({}),
    ready: Promise.resolve({}),
    addEventListener: vi.fn((type: string, handler: () => void) =>
      listeners.set(type, handler),
    ),
    removeEventListener: vi.fn(),
    ...overrides,
  };

  vi.stubGlobal('navigator', { serviceWorker: container });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('ensureController', () => {
  it('reports no worker where the browser has none', async () => {
    vi.stubGlobal('navigator', {});

    const { ensureController } = await load();

    // Not an error — the app still runs, it just can't cache or go offline.
    await expect(ensureController()).resolves.toBe(false);
  });

  it('resolves immediately when a worker already controls the page', async () => {
    stubServiceWorker({ controller: {} });

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
  });

  it('registers even when a worker already controls the page', async () => {
    // The registration doubles as the update check. Skipping it would leave a
    // running worker to be replaced only by the browser's own polling, which
    // is what makes an edit to sw.ts appear not to take.
    stubServiceWorker({ controller: {} });

    const { ensureController } = await load();
    await ensureController();

    expect(container.register).toHaveBeenCalledWith('/sw.js');
  });

  it('registers and waits for the worker to claim this page', async () => {
    // A fresh registration does not control the page that made it, so
    // resolving on `ready` alone would let the preload start uncontrolled —
    // on exactly the visit where everything downloads.
    stubServiceWorker();

    const { ensureController } = await load();
    const pending = ensureController();

    await vi.waitFor(() =>
      expect(listeners.has('controllerchange')).toBe(true),
    );
    listeners.get('controllerchange')?.();

    await expect(pending).resolves.toBe(true);
    expect(container.register).toHaveBeenCalledWith('/sw.js');
  });

  it('asks only once however many callers there are', async () => {
    stubServiceWorker({ controller: {} });

    const { ensureController } = await load();
    const [a, b] = await Promise.all([ensureController(), ensureController()]);

    expect([a, b]).toEqual([true, true]);
  });

  it('reports no worker rather than throwing when registration fails', async () => {
    stubServiceWorker({
      register: vi.fn().mockRejectedValue(new Error('bad MIME type')),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('registers in dev as well as production', async () => {
    // The dev worker precaches no shell, so it can cache the gigabytes and
    // report their bytes without any of the staleness that used to rule a dev
    // registration out. Vitest itself runs as DEV, so this needs no stubbing.
    expect(import.meta.env.DEV).toBe(true);
    stubServiceWorker({ controller: {} });

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
    expect(container.register).toHaveBeenCalledWith('/sw.js');
  });
});
