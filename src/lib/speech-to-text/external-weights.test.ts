import { describe, expect, it, vi } from 'vitest';
import type { InferenceSession } from 'onnxruntime-web/webgpu';

import {
  loadWeightsExternally,
  splitWeights,
} from '#/lib/speech-to-text/external-weights';

// Just enough protobuf to build an ONNX model by hand and read one back.

function varint(value: number): number[] {
  const out: number[] = [];
  while (value >= 128) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return out;
}

function len(number: number, ...payload: (Uint8Array | string)[]) {
  const bytes = payload.map((p) =>
    typeof p === 'string' ? new TextEncoder().encode(p) : p,
  );
  const length = bytes.reduce((n, b) => n + b.length, 0);
  return concat(
    Uint8Array.from([...varint(number * 8 + 2), ...varint(length)]),
    ...bytes,
  );
}

function int(number: number, value: number) {
  return Uint8Array.from([...varint(number * 8), ...varint(value)]);
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type Fields = Map<number, (Uint8Array | number)[]>;

function decode(bytes: Uint8Array): Fields {
  const fields: Fields = new Map();
  let pos = 0;
  const read = () => {
    let value = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[pos++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  };
  while (pos < bytes.length) {
    const tag = read();
    let value: Uint8Array | number;
    if (tag % 8 === 2) {
      const length = read();
      value = bytes.subarray(pos, pos + length);
      pos += length;
    } else {
      value = read();
    }
    const number = Math.floor(tag / 8);
    fields.set(number, [...(fields.get(number) ?? []), value]);
  }
  return fields;
}

function message(fields: Fields, number: number, index = 0): Fields {
  return decode(fields.get(number)![index] as Uint8Array);
}

function text(fields: Fields, number: number) {
  return new TextDecoder().decode(fields.get(number)![0] as Uint8Array);
}

function externalData(tensor: Fields) {
  return Object.fromEntries(
    (tensor.get(13) ?? []).map((entry) => {
      const fields = decode(entry as Uint8Array);
      return [text(fields, 1), text(fields, 2)];
    }),
  );
}

function bytesOf(size: number, seed: number) {
  return Uint8Array.from({ length: size }, (_, i) => (i * 7 + seed) % 251);
}

const BIG = bytesOf(2048, 1);
const SMALL = bytesOf(8, 2);
const BRANCH = bytesOf(4096, 3);

// TensorProto: dims 1, data_type 2, name 8, raw_data 9.
const tensor = (name: string, raw: Uint8Array) =>
  concat(int(1, raw.length), int(2, 2), len(8, name), len(9, raw));

// A model with a large and a small initializer, and an If node whose branch
// holds a large initializer of its own, as the merged decoder's do.
const MODEL = concat(
  int(1, 8), // ir_version
  len(
    7, // graph
    len(
      1, // node
      len(4, 'If'), // op_type
      len(5, len(1, 'then_branch'), len(6, len(5, tensor('branch', BRANCH)))),
    ),
    len(2, 'main'),
    len(5, tensor('big', BIG)),
    len(5, tensor('small', SMALL)),
  ),
);

function readBack(graph: Uint8Array) {
  const model = decode(graph);
  const main = message(model, 7);
  const node = decode(main.get(1)![0] as Uint8Array);
  const branch = message(message(node, 5), 6);
  return {
    model,
    main,
    big: message(main, 5, 0),
    small: message(main, 5, 1),
    branch: message(branch, 5),
  };
}

describe('splitWeights', () => {
  it('points a large weight at its own bytes in the original file', () => {
    const { big } = readBack(splitWeights(MODEL).graph);

    expect(big.has(9)).toBe(false);
    expect(big.get(14)).toEqual([1]); // data_location: EXTERNAL
    const { location, offset, length } = externalData(big);
    expect(location).toBe('weights');
    expect(Number(length)).toBe(BIG.length);
    expect(MODEL.subarray(Number(offset), Number(offset) + BIG.length)).toEqual(
      BIG,
    );
  });

  it('keeps the rest of the tensor', () => {
    const { big } = readBack(splitWeights(MODEL).graph);

    expect(text(big, 8)).toBe('big');
    expect(big.get(1)).toEqual([BIG.length]);
    expect(big.get(2)).toEqual([2]);
  });

  it('moves weights inside a subgraph too', () => {
    const { branch } = readBack(splitWeights(MODEL).graph);

    expect(branch.has(9)).toBe(false);
    const { offset, length } = externalData(branch);
    expect(
      MODEL.subarray(Number(offset), Number(offset) + Number(length)),
    ).toEqual(BRANCH);
  });

  it('leaves a small weight inline', () => {
    const { small } = readBack(splitWeights(MODEL).graph);

    expect(small.get(9)).toEqual([SMALL]);
    expect(small.has(13)).toBe(false);
  });

  it('keeps the fields around the weights', () => {
    const { model, main } = readBack(splitWeights(MODEL).graph);

    expect(model.get(1)).toEqual([8]);
    expect(text(main, 2)).toBe('main');
  });

  it('reports how many bytes it moved', () => {
    expect(splitWeights(MODEL).moved).toBe(BIG.length + BRANCH.length);
  });

  it('throws on a truncated model', () => {
    expect(() => splitWeights(MODEL.subarray(0, 100))).toThrow(/Truncated/);
  });

  it('hands over only the original file when nothing is transposed', () => {
    expect(splitWeights(MODEL).externalData).toEqual([
      { path: 'weights', data: MODEL },
    ]);
  });
});

describe('splitWeights, transposing a weight', () => {
  const ROWS = 16;
  const COLS = 32;
  const VALUES = Float32Array.from({ length: ROWS * COLS }, (_, i) => i);

  // The decoder's shape: a main-graph weight transposed by the same node, to
  // the same name, in each branch of an If. `perm` as attribute bytes, if any.
  function transposingModel(perm?: Uint8Array) {
    const node = concat(
      len(1, 'embed'),
      len(2, 'embed_t'),
      len(4, 'Transpose'),
      ...(perm ? [len(5, len(1, 'perm'), perm)] : []),
    );
    const branch = (name: string) => len(5, len(1, name), len(6, len(1, node)));
    return concat(
      len(
        7,
        len(1, len(4, 'If'), branch('then_branch'), branch('else_branch')),
        len(
          5,
          int(1, ROWS),
          int(1, COLS),
          int(2, 1), // FLOAT
          len(8, 'embed'),
          len(9, new Uint8Array(VALUES.buffer)),
        ),
      ),
    );
  }

  function readBranches(graph: Uint8Array) {
    const main = message(decode(graph), 7);
    const node = decode(main.get(1)![0] as Uint8Array);
    const initializers = (main.get(5) as Uint8Array[]).map(decode);
    return {
      branches: (node.get(5) as Uint8Array[]).map((a) => message(decode(a), 6)),
      initializer: (name: string) =>
        initializers.find((tensor) => text(tensor, 8) === name),
    };
  }

  it('drops the Transpose from both branches', () => {
    const { branches } = readBranches(splitWeights(transposingModel()).graph);

    expect(branches.map((branch) => branch.has(1))).toEqual([false, false]);
  });

  it('puts one transposed copy in the main graph, as external data', () => {
    const model = transposingModel();
    const { graph, externalData: files } = splitWeights(model);
    const transposed = readBranches(graph).initializer('embed_t')!;

    expect(transposed.get(1)).toEqual([COLS, ROWS]);
    expect(transposed.get(2)).toEqual([1]);
    expect(externalData(transposed)).toEqual({
      location: 'transposed',
      offset: '0',
      length: String(VALUES.byteLength),
    });

    const expected = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        expected[c * ROWS + r] = VALUES[r * COLS + c];
      }
    }
    expect(files).toHaveLength(2);
    expect(files[1].path).toBe('transposed');
    expect(new Float32Array(files[1].data.slice().buffer)).toEqual(expected);
  });

  it('frees the copy it makes of a weight that starts unaligned', () => {
    const transfer = vi.spyOn(
      ArrayBuffer.prototype as unknown as {
        transfer: (length: number) => ArrayBuffer;
      },
      'transfer',
    );
    const expected = splitWeights(transposingModel()).externalData[1].data;

    // An ir_version of 2 to 5 bytes ahead of the graph moves the weight, the
    // model's last bytes, through every alignment.
    for (const version of [1, 200, 20000, 3000000]) {
      const model = concat(int(1, version), transposingModel());
      const unaligned = (model.length - VALUES.byteLength) % 4 !== 0;
      transfer.mockClear();

      const { externalData: files } = splitWeights(model);

      expect(files[1].data).toEqual(expected);
      expect(transfer).toHaveBeenCalledTimes(unaligned ? 1 : 0);
    }

    transfer.mockRestore();
  });

  it('still moves the weight being transposed', () => {
    const embed = readBranches(
      splitWeights(transposingModel()).graph,
    ).initializer('embed')!;

    expect(externalData(embed).location).toBe('weights');
  });

  it('does the same for an explicit perm of [1, 0]', () => {
    const { externalData: files } = splitWeights(
      transposingModel(len(8, Uint8Array.of(1, 0))),
    );

    expect(files).toHaveLength(2);
  });

  it('leaves any other perm to ORT', () => {
    const model = transposingModel(len(8, Uint8Array.of(0, 1)));
    const { graph, externalData: files } = splitWeights(model);

    expect(files).toHaveLength(1);
    expect(readBranches(graph).branches.map((branch) => branch.has(1))).toEqual(
      [true, true],
    );
  });
});

describe('loadWeightsExternally', () => {
  interface File {
    path: string;
    data: Uint8Array;
  }

  interface Call {
    model: unknown;
    options: { externalData?: File[]; [key: string]: unknown };
  }

  /**
   * `create` records each call twice over: as it was handed the arguments,
   * and as copies taken there and then, since the originals are detached once
   * the session is built.
   */
  function factory(result: () => Promise<unknown> = async () => 'session') {
    const handed: Call[] = [];
    const copied: Call[] = [];
    const create = vi.fn(async (model: unknown, options: Call['options']) => {
      handed.push({ model, options });
      copied.push({
        model: model instanceof Uint8Array ? model.slice() : model,
        options: {
          ...options,
          ...(options.externalData && {
            externalData: options.externalData.map((file) => ({
              ...file,
              data: file.data.slice(),
            })),
          }),
        },
      });
      return result();
    });
    const session = { create } as unknown as typeof InferenceSession;
    loadWeightsExternally(session);
    return { session, create, handed, copied };
  }

  it('creates a session from bytes with the weights as external data', async () => {
    const { session, copied } = factory();

    await session.create(MODEL.slice(), { executionProviders: ['webgpu'] });

    expect(copied).toEqual([
      {
        model: splitWeights(MODEL).graph,
        options: {
          executionProviders: ['webgpu'],
          externalData: [{ path: 'weights', data: MODEL }],
        },
      },
    ]);
  });

  it('keeps external data it was already given', async () => {
    const { session, copied } = factory();
    const other = { path: 'other', data: new Uint8Array(1) };

    await session.create(MODEL.slice(), { externalData: [other] });

    expect(copied[0].options.externalData).toEqual([
      other,
      { path: 'weights', data: MODEL },
    ]);
  });

  it('passes a URL through untouched', async () => {
    const { session, create } = factory();

    await session.create('model.onnx', { executionProviders: ['webgpu'] });

    expect(create).toHaveBeenCalledWith('model.onnx', {
      executionProviders: ['webgpu'],
    });
  });

  it('frees the bytes it was given and made once the session is built', async () => {
    const { session, handed } = factory();
    const model = MODEL.slice();

    await session.create(model);

    expect(model.byteLength).toBe(0);
    expect((handed[0].model as Uint8Array).byteLength).toBe(0);
    for (const file of handed[0].options.externalData!) {
      expect(file.data.byteLength).toBe(0);
    }
  });

  it('frees them when the session fails to build too', async () => {
    const { session } = factory(() => Promise.reject(new Error('no gpu')));
    const model = MODEL.slice();

    await expect(session.create(model)).rejects.toThrow('no gpu');

    expect(model.byteLength).toBe(0);
  });

  it('leaves alone bytes that share their buffer', async () => {
    const { session } = factory();
    const shared = new Uint8Array(MODEL.length + 8);
    shared.set(MODEL);
    const model = shared.subarray(0, MODEL.length);

    await session.create(model);

    expect(model).toEqual(MODEL);
  });

  it('leaves alone external data it was already given', async () => {
    const { session } = factory();
    const other = { path: 'other', data: new Uint8Array(1) };

    await session.create(MODEL.slice(), { externalData: [other] });

    expect(other.data.byteLength).toBe(1);
  });
});
