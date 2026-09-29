import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAIM } from '#/lib/cache/channel';

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

interface FakeRegistration {
  update: ReturnType<typeof vi.fn>;
  waiting: FakeWorker | null;
  installing: FakeWorker | null;
}

interface FakeWorker {
  state: string;
  addEventListener: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}

let container: FakeContainer;
let registration: FakeRegistration;
let listeners: Map<string, () => void>;

function stubServiceWorker(overrides: Partial<FakeContainer> = {}) {
  listeners = new Map();

  registration = {
    update: vi.fn().mockResolvedValue(undefined),
    waiting: null,
    installing: null,
  };

  container = {
    controller: null,
    register: vi.fn().mockResolvedValue(registration),
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

  it('asks an already-active worker to claim a page loaded past it', async () => {
    // A hard reload bypasses the worker, and one that is already active never
    // activates again to claim the page by itself. Without the ask, startup
    // sits out the whole timeout and then runs uncached.
    const active = {
      postMessage: vi.fn(() => listeners.get('controllerchange')?.()),
    };
    stubServiceWorker({ ready: Promise.resolve({ active }) });

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
    expect(active.postMessage).toHaveBeenCalledWith(CLAIM);
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

describe('applying a new deploy at startup', () => {
  let reload: ReturnType<typeof vi.fn>;

  /** A worker that answers TAKE_OVER with `answer` over the port it's sent. */
  function fakeWorker(state: string, answer: boolean): FakeWorker {
    return {
      state,
      addEventListener: vi.fn(),
      postMessage: vi.fn((_message: unknown, [port]: MessagePort[]) =>
        port.postMessage(answer),
      ),
    };
  }

  /** Whether `promise` is still pending once everything queued has run. */
  async function isPending(promise: Promise<unknown>) {
    const pending = Symbol('pending');
    const settled = await Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
    ]);
    return settled === pending;
  }

  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal('location', { reload });
    stubServiceWorker({ controller: {} });
  });

  it('asks a waiting update to take over, and reloads into it', async () => {
    const worker = fakeWorker('installed', true);
    registration.waiting = worker;

    const { ensureController } = await load();
    const pending = ensureController();

    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    listeners.get('controllerchange')?.();

    expect(reload).toHaveBeenCalled();
    // Held, so the app doesn't start on a page that's about to go.
    expect(await isPending(pending)).toBe(true);
  });

  it('starts straight away when nothing is waiting, without touching the network', async () => {
    // Checking for a deploy is the browser's job, done in the background on
    // navigation. Asking here would hold every startup on a round trip — or,
    // on a connection that hangs, on the timeout.
    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
    expect(registration.update).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('leaves an update that is still installing for the next load', async () => {
    const worker = fakeWorker('installing', true);
    registration.installing = worker;

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it('starts on the current build while another tab is running the app', async () => {
    registration.waiting = fakeWorker('installed', false);

    const { ensureController } = await load();

    await expect(ensureController()).resolves.toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('starts on the current build if the worker never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const worker = fakeWorker('installed', true);
    worker.postMessage.mockImplementation(() => {});
    registration.waiting = worker;

    const { ensureController } = await load();
    const pending = ensureController();

    await vi.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toBe(true);
    expect(reload).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
