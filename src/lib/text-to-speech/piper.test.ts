import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ONNX_WASM_BASE,
  PIPER_WASM_BASE,
  voiceUrls,
} from '#/lib/text-to-speech/constants';
import {
  loadVoice,
  phonemize,
  synthesize,
  toWav,
  type PiperVoice,
  type VoiceConfig,
} from '#/lib/text-to-speech/piper';

const ort = vi.hoisted(() => ({
  env: { wasm: {} as { wasmPaths?: unknown; numThreads?: number } },
  InferenceSession: { create: vi.fn() },
  Tensor: class {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  },
}));

vi.mock('onnxruntime-web/wasm', () => ort);

interface FakeOptions {
  print: (line: string) => void;
  printErr: (line: string) => void;
  locateFile: (path: string) => string;
  getPreloadedPackage: (name: string, size: number) => ArrayBuffer;
}

const PHONEMIZER_DATA_URL = `${PIPER_WASM_BASE}piper_phonemize.data`;
const PHONEMIZER_DATA = new Uint8Array([7, 8, 9]);

const createPiperPhonemize = vi.hoisted(() => vi.fn());

vi.mock('@diffusionstudio/piper-wasm/build/piper_phonemize.js', () => ({
  default: createPiperPhonemize,
}));

/** Makes the phonemizer answer each run by calling `main` with its options. */
function phonemizerRuns(main: (options: FakeOptions, args: string[]) => void) {
  createPiperPhonemize.mockImplementation(async (options: FakeOptions) => ({
    callMain: (args: string[]) => {
      main(options, args);
      return 0;
    },
  }));
}

function printsIds(ids: number[]) {
  phonemizerRuns((options) =>
    options.print(JSON.stringify({ phoneme_ids: ids })),
  );
}

const CONFIG: VoiceConfig = {
  audio: { sample_rate: 22050 },
  espeak: { voice: 'es' },
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
  speaker_id_map: {},
};

function voiceWith(config: Partial<VoiceConfig> = {}) {
  const run = vi.fn().mockResolvedValue({
    output: { data: new Float32Array([0.5, -0.5]) },
  });
  const voice = {
    config: { ...CONFIG, ...config },
    session: { run },
  } as unknown as PiperVoice;
  return { voice, run };
}

// What every phonemizer is lent. loadVoice's tests stub their own.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(PHONEMIZER_DATA)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * piper.ts as if just loaded, so nothing it has cached carries over from an
 * earlier test. The mocks above still apply.
 */
async function freshPiper() {
  vi.resetModules();
  return import('#/lib/text-to-speech/piper');
}

describe('ORT setup', () => {
  it('loads ORT’s wasm from our vendored copy, on one thread', () => {
    expect(ort.env.wasm.wasmPaths).toBe(ONNX_WASM_BASE);
    expect(ort.env.wasm.numThreads).toBe(1);
  });
});

describe('loadVoice', () => {
  const VOICE_ID = 'es_ES-davefx-medium';
  const urls = voiceUrls(VOICE_ID);
  const MODEL = new Uint8Array([1, 2, 3]).buffer;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === urls.config
          ? new Response(JSON.stringify(CONFIG))
          : new Response(MODEL),
      ),
    );
    ort.InferenceSession.create.mockResolvedValue('session');
  });

  it('downloads the voice’s model and config, and builds a session on the wasm EP', async () => {
    const voice = await loadVoice(VOICE_ID);

    expect(fetch).toHaveBeenCalledWith(urls.config);
    expect(fetch).toHaveBeenCalledWith(urls.model);
    expect(voice).toEqual({ config: CONFIG, session: 'session' });

    const [bytes, options] = ort.InferenceSession.create.mock.calls[0];
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array(MODEL));
    expect(options).toEqual({ executionProviders: ['wasm'] });
  });

  it('rejects, without building a session, when a file fails to download', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(loadVoice(VOICE_ID)).rejects.toThrow(
      'Failed to download voice (404)',
    );
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
  });
});

describe('phonemize', () => {
  it('runs the phonemizer on the text in the given espeak voice', async () => {
    let args: string[] = [];
    phonemizerRuns((options, received) => {
      args = received;
      options.print(JSON.stringify({ phoneme_ids: [1, 2, 3] }));
    });

    await expect(phonemize('Hola', 'es')).resolves.toEqual([1, 2, 3]);
    expect(args).toEqual([
      '-l',
      'es',
      '--input',
      JSON.stringify([{ text: 'Hola' }]),
      '--espeak_data',
      '/espeak-ng-data',
    ]);
  });

  it('loads the phonemizer’s wasm and data from our vendored copy', async () => {
    const { phonemize } = await freshPiper();
    printsIds([1]);

    await phonemize('Hola', 'es');

    const { locateFile, getPreloadedPackage } = createPiperPhonemize.mock
      .calls[0][0] as FakeOptions;
    expect(locateFile('piper_phonemize.wasm')).toBe(
      `${PIPER_WASM_BASE}piper_phonemize.wasm`,
    );
    expect(fetch).toHaveBeenCalledWith(PHONEMIZER_DATA_URL);
    expect(
      new Uint8Array(getPreloadedPackage('piper_phonemize.data', 3)),
    ).toEqual(PHONEMIZER_DATA);
  });

  // Reusing one phonemizer isn't safe — see `phonemize` — but its data is.
  it('starts a fresh phonemizer for every call, lending each the same data', async () => {
    const { phonemize } = await freshPiper();
    printsIds([1]);

    await phonemize('uno', 'es');
    await phonemize('dos', 'es');

    expect(createPiperPhonemize).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
    const [first, second] = createPiperPhonemize.mock.calls.map(([options]) =>
      (options as FakeOptions).getPreloadedPackage('piper_phonemize.data', 3),
    );
    expect(second).toBe(first);
  });

  it('fetches the data again after a download that failed', async () => {
    const { phonemize } = await freshPiper();
    printsIds([1]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 404 }));

    await expect(phonemize('uno', 'es')).rejects.toThrow(
      'Failed to download phonemizer data (404)',
    );
    expect(createPiperPhonemize).not.toHaveBeenCalled();

    await expect(phonemize('dos', 'es')).resolves.toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects with what the phonemizer wrote to stderr when it prints nothing', async () => {
    phonemizerRuns((options) => options.printErr('unknown voice: xx'));

    await expect(phonemize('Hola', 'xx')).rejects.toThrow('unknown voice: xx');
  });
});

describe('synthesize', () => {
  beforeEach(() => printsIds([1, 20, 30, 2]));

  it('feeds the model the phoneme ids, their count and the voice’s scales', async () => {
    const { voice, run } = voiceWith();

    const samples = await synthesize(voice, 'Hola');

    expect(samples).toEqual(new Float32Array([0.5, -0.5]));
    const [feeds] = run.mock.calls[0];
    expect(feeds.input).toMatchObject({
      type: 'int64',
      data: BigInt64Array.of(1n, 20n, 30n, 2n),
      dims: [1, 4],
    });
    expect(feeds.input_lengths).toMatchObject({
      type: 'int64',
      data: BigInt64Array.of(4n),
      dims: [1],
    });
    expect(feeds.scales).toMatchObject({
      type: 'float32',
      data: Float32Array.of(0.667, 1, 0.8),
      dims: [3],
    });
  });

  it('multiplies the voice’s own length scale by the one asked for', async () => {
    const { voice, run } = voiceWith({
      inference: { noise_scale: 0.667, length_scale: 1.2, noise_w: 0.8 },
    });

    await synthesize(voice, 'Hola', 1.5);

    expect(run.mock.calls[0][0].scales.data[1]).toBeCloseTo(1.8);
  });

  it('phonemizes the trimmed text in the voice’s espeak voice', async () => {
    let input = '';
    let language = '';
    phonemizerRuns((options, args) => {
      language = args[1];
      input = args[3];
      options.print(JSON.stringify({ phoneme_ids: [1] }));
    });
    const { voice } = voiceWith();

    await synthesize(voice, '  Hola  ');

    expect(language).toBe('es');
    expect(input).toBe(JSON.stringify([{ text: 'Hola' }]));
  });

  it('only names a speaker for a multi-speaker voice', async () => {
    const single = voiceWith();
    const multi = voiceWith({ speaker_id_map: { ana: 0, luis: 1 } });

    await synthesize(single.voice, 'Hola');
    await synthesize(multi.voice, 'Hola');

    expect(single.run.mock.calls[0][0]).not.toHaveProperty('sid');
    expect(multi.run.mock.calls[0][0].sid).toMatchObject({
      type: 'int64',
      data: BigInt64Array.of(0n),
      dims: [1],
    });
  });

  it('refuses blank text without running anything', async () => {
    const { voice, run } = voiceWith();

    await expect(synthesize(voice, '   ')).rejects.toThrow('No text to speak');
    expect(createPiperPhonemize).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('toWav', () => {
  function ascii(view: DataView, offset: number, length: number) {
    return String.fromCharCode(
      ...Array.from({ length }, (_, i) => view.getUint8(offset + i)),
    );
  }

  it('writes a 16-bit mono PCM header for the sample rate', () => {
    const view = new DataView(toWav(new Float32Array(3), 22050));

    expect(view.byteLength).toBe(44 + 3 * 2);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
    expect(ascii(view, 8, 8)).toBe('WAVEfmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(22050);
    expect(view.getUint32(28, true)).toBe(22050 * 2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(3 * 2);
  });

  it('scales samples to 16 bits, clamping anything out of range', () => {
    const view = new DataView(
      toWav(new Float32Array([0, 0.5, -0.5, 1.5, -1.5]), 22050),
    );

    const samples = Array.from({ length: 5 }, (_, i) =>
      view.getInt16(44 + i * 2, true),
    );
    expect(samples).toEqual([0, 16384, -16384, 32767, -32768]);
  });
});
