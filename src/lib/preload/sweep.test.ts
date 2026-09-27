import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { version as LITERT_VERSION } from '@litert-lm/core/package.json';
import { MODELS_CACHE } from '#/lib/cache/names';
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from '#/lib/chat/constants';
import { sweepStaleAssets } from '#/lib/preload/sweep';
import { TRANSFORMERS_ORT_VERSION } from '#/lib/speech-to-text/constants';
import {
  ONNX_WASM_BASE,
  PIPER_WASM_BASE,
} from '#/lib/text-to-speech/constants';
import { stubCacheStorage, type FakeCache } from '#/test-utils';

const OTHER_CHAT_MODEL =
  DEFAULT_CHAT_MODEL === CHAT_MODELS.e2b ? CHAT_MODELS.e4b : CHAT_MODELS.e2b;

/** What the current build downloads: every one of these must survive. */
const CURRENT = [
  `${location.origin}${ONNX_WASM_BASE}ort-wasm-simd-threaded.wasm`,
  `${location.origin}${PIPER_WASM_BASE}piper_phonemize.data`,
  'https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model.onnx',
  'https://huggingface.co/onnx-community/whisper-small/resolve/main/config.json',
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${TRANSFORMERS_ORT_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`,
  `https://cdn.jsdelivr.net/npm/@litert-lm/core@${LITERT_VERSION}/wasm/litertlm_wasm_internal.wasm`,
  DEFAULT_CHAT_MODEL,
];

/** Step markers and write-failure records: tiny, and never swept. */
const BOOKKEEPING = [
  'https://step.invalid/chat/some-old-model',
  'https://write-failed.invalid/chat',
];

let buckets: Map<string, FakeCache>;

async function seed(urls: string[]) {
  const cache = await caches.open(MODELS_CACHE);
  for (const url of urls) await cache.put(url, new Response('x'));
}

function remaining(): string[] {
  return Array.from(buckets.get(MODELS_CACHE)?.store.keys() ?? []);
}

beforeEach(() => {
  buckets = stubCacheStorage();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sweepStaleAssets', () => {
  it('keeps everything the current build uses, and the bookkeeping', async () => {
    await seed([...CURRENT, ...BOOKKEEPING]);

    await expect(sweepStaleAssets()).resolves.toBe(0);

    expect(remaining().sort()).toEqual([...CURRENT, ...BOOKKEEPING].sort());
  });

  it('deletes another version of each thing the app downloads', async () => {
    const stale = [
      `${location.origin}/vendor/onnx/1.20.0/ort-wasm-simd-threaded.wasm`,
      `${location.origin}/vendor/piper-wasm/0.9.0/piper_phonemize.data`,
      // What every returning user still has from before the move to small.
      'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/decoder_model_merged_quantized.onnx',
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.jsep.wasm',
      'https://cdn.jsdelivr.net/npm/@litert-lm/core@0.13.0/wasm/litertlm_wasm_internal.wasm',
      OTHER_CHAT_MODEL,
    ];
    await seed([...CURRENT, ...stale]);

    await expect(sweepStaleAssets()).resolves.toBe(stale.length);

    expect(remaining().sort()).toEqual([...CURRENT].sort());
  });

  it('does not take a similarly named model for the current one', async () => {
    const url =
      'https://huggingface.co/onnx-community/whisper-small.en/resolve/main/onnx/encoder_model.onnx';
    await seed([url]);

    await sweepStaleAssets();

    expect(remaining()).not.toContain(url);
  });

  it('deletes what no rule matches any more', async () => {
    // The service worker would never serve it again.
    await seed(['https://example.com/models/retired.bin']);

    await expect(sweepStaleAssets()).resolves.toBe(1);
    expect(remaining()).toEqual([]);
  });

  it('keeps a runtime whose version it cannot read', async () => {
    // Only what it is sure about goes; a wrong guess would cost a download
    // on every visit.
    const url = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@/dist/x.wasm';
    await seed([url]);

    await expect(sweepStaleAssets()).resolves.toBe(0);
    expect(remaining()).toEqual([url]);
  });

  it('resolves 0 where there is no Cache Storage', async () => {
    vi.unstubAllGlobals();

    await expect(sweepStaleAssets()).resolves.toBe(0);
  });

  it('resolves 0 rather than rejecting when storage fails', async () => {
    vi.mocked(caches.open).mockRejectedValue(new Error('storage gone'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sweepStaleAssets()).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
