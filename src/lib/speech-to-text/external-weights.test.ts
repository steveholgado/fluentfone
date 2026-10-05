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
});

describe('loadWeightsExternally', () => {
  function factory() {
    const create = vi.fn().mockResolvedValue('session');
    const session = { create } as unknown as typeof InferenceSession;
    loadWeightsExternally(session);
    return { session, create };
  }

  it('creates a session from bytes with the weights as external data', async () => {
    const { session, create } = factory();

    await session.create(MODEL, { executionProviders: ['webgpu'] });

    expect(create).toHaveBeenCalledWith(splitWeights(MODEL).graph, {
      executionProviders: ['webgpu'],
      externalData: [{ path: 'weights', data: MODEL }],
    });
  });

  it('keeps external data it was already given', async () => {
    const { session, create } = factory();
    const other = { path: 'other', data: new Uint8Array(1) };

    await session.create(MODEL, { externalData: [other] });

    expect(create.mock.calls[0][1].externalData).toEqual([
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
});
