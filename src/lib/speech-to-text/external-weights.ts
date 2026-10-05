/**
 * Keeps Whisper's weights out of ORT's wasm heap.
 *
 * Handed a model as bytes, ORT copies the whole file into its wasm heap to
 * parse it, then (on WebGPU) uploads the weights to the GPU. The copy is
 * freed, but wasm memory never shrinks, so the worker goes on holding a heap
 * the size of every model it has loaded, on top of the same weights on the
 * GPU.
 *
 * Weights stored as ONNX external data take another route: ORT uploads each
 * one to the GPU straight from the JS buffer it was given, and only the graph
 * passes through the heap. The Hub's files keep their weights inline, so this
 * rewrites each model as it is loaded: a copy of the graph whose large weights
 * point at their own bytes in the original file, which is then handed over
 * whole as the external data. No weight is copied, and the files downloaded
 * (and what the service worker caches) stay as they are.
 *
 * Switched by EXTERNAL_WEIGHTS in constants.ts.
 */

import type { InferenceSession } from 'onnxruntime-web/webgpu';

/** The name the rewritten graph gives the original file, and ORT is given it under. */
const WEIGHTS_PATH = 'weights';

/**
 * Smaller weights stay in the graph: not worth an entry each, and the ones
 * read on the CPU (shapes, axes) would be copied into the heap regardless.
 * The same cutoff `onnx.save` uses when it writes external data.
 */
const MIN_EXTERNAL_BYTES = 1024;

// Field numbers from onnx.proto, for the messages on the way to a weight.
const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const GRAPH_INITIALIZER = 5;
const NODE_ATTRIBUTE = 5;
const ATTRIBUTE_GRAPH = 6;
const ATTRIBUTE_GRAPHS = 11;
const TENSOR_RAW_DATA = 9;
const TENSOR_EXTERNAL_DATA = 13;
const TENSOR_DATA_LOCATION = 14;
const ENTRY_KEY = 1;
const ENTRY_VALUE = 2;
const DATA_LOCATION_EXTERNAL = 1;

// Protobuf wire types.
const VARINT = 0;
const FIXED64 = 1;
const LEN = 2;
const FIXED32 = 5;

type Message = 'model' | 'graph' | 'node' | 'attribute';

/**
 * The fields that lead to weights, and what each holds. Subgraphs count: the
 * merged decoder is an `If` over two branches, and its q4 build keeps
 * quantized weights inside them.
 */
const CHILDREN: Record<Message, Record<number, Message | 'tensor'>> = {
  model: { [MODEL_GRAPH]: 'graph' },
  graph: { [GRAPH_NODE]: 'node', [GRAPH_INITIALIZER]: 'tensor' },
  node: { [NODE_ATTRIBUTE]: 'attribute' },
  attribute: { [ATTRIBUTE_GRAPH]: 'graph', [ATTRIBUTE_GRAPHS]: 'graph' },
};

interface Field {
  number: number;
  wireType: number;
  /** Where the field starts, tag included. */
  start: number;
  /** Where a length-delimited field's payload starts. */
  dataStart: number;
  end: number;
}

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  let byte;
  do {
    if (pos >= bytes.length) throw new Error('Truncated ONNX model.');
    byte = bytes[pos++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, pos];
}

function* fields(bytes: Uint8Array, start: number, end: number) {
  let pos = start;
  while (pos < end) {
    const fieldStart = pos;
    let tag;
    [tag, pos] = readVarint(bytes, pos);
    const wireType = tag % 8;
    let dataStart = pos;
    switch (wireType) {
      case VARINT:
        pos = readVarint(bytes, pos)[1];
        break;
      case FIXED64:
        pos += 8;
        break;
      case LEN: {
        let length;
        [length, dataStart] = readVarint(bytes, pos);
        pos = dataStart + length;
        break;
      }
      case FIXED32:
        pos += 4;
        break;
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}.`);
    }
    if (pos > end) throw new Error('Truncated ONNX model.');
    yield {
      number: Math.floor(tag / 8),
      wireType,
      start: fieldStart,
      dataStart,
      end: pos,
    } satisfies Field;
  }
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  while (value >= 128) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthDelimited(number: number, payload: Uint8Array): Uint8Array {
  return concat([varint(number * 8 + LEN), varint(payload.length), payload]);
}

function externalDataEntry(key: string, value: string): Uint8Array {
  const encoder = new TextEncoder();
  return lengthDelimited(
    TENSOR_EXTERNAL_DATA,
    concat([
      lengthDelimited(ENTRY_KEY, encoder.encode(key)),
      lengthDelimited(ENTRY_VALUE, encoder.encode(value)),
    ]),
  );
}

/**
 * A TensorProto with its `raw_data` swapped for where those bytes sit in the
 * file, or the tensor as it was if it's too small to bother.
 */
function rewriteTensor(
  bytes: Uint8Array,
  start: number,
  end: number,
): { tensor: Uint8Array; moved: number } {
  let raw: Field | undefined;
  for (const field of fields(bytes, start, end)) {
    if (field.number === TENSOR_RAW_DATA && field.wireType === LEN) {
      raw = field;
    }
  }
  const length = raw ? raw.end - raw.dataStart : 0;
  if (!raw || length < MIN_EXTERNAL_BYTES) {
    return { tensor: bytes.subarray(start, end), moved: 0 };
  }

  const parts: Uint8Array[] = [];
  for (const field of fields(bytes, start, end)) {
    if (
      field.number !== TENSOR_RAW_DATA &&
      field.number !== TENSOR_DATA_LOCATION
    ) {
      parts.push(bytes.subarray(field.start, field.end));
    }
  }
  parts.push(
    externalDataEntry('location', WEIGHTS_PATH),
    externalDataEntry('offset', String(raw.dataStart)),
    externalDataEntry('length', String(length)),
    varint(TENSOR_DATA_LOCATION * 8 + VARINT),
    varint(DATA_LOCATION_EXTERNAL),
  );
  return { tensor: concat(parts), moved: length };
}

function rewriteMessage(
  bytes: Uint8Array,
  start: number,
  end: number,
  message: Message,
): { body: Uint8Array; moved: number } {
  const parts: Uint8Array[] = [];
  let moved = 0;
  for (const field of fields(bytes, start, end)) {
    const child =
      field.wireType === LEN ? CHILDREN[message][field.number] : undefined;
    if (!child) {
      parts.push(bytes.subarray(field.start, field.end));
      continue;
    }
    const rewritten =
      child === 'tensor'
        ? rewriteTensor(bytes, field.dataStart, field.end)
        : rewriteMessage(bytes, field.dataStart, field.end, child);
    const body = 'tensor' in rewritten ? rewritten.tensor : rewritten.body;
    parts.push(lengthDelimited(field.number, body));
    moved += rewritten.moved;
  }
  return { body: concat(parts), moved };
}

/**
 * Rewrites an ONNX model so that every weight of MIN_EXTERNAL_BYTES or more
 * is external data in WEIGHTS_PATH, at the offset its bytes already have in
 * `model`. `model` itself is then that file.
 */
export function splitWeights(model: Uint8Array): {
  graph: Uint8Array;
  /** How many bytes of weights the graph now points at instead of holding. */
  moved: number;
} {
  const { body, moved } = rewriteMessage(model, 0, model.length, 'model');
  return { graph: body, moved };
}

type Create = (model: unknown, ...rest: unknown[]) => Promise<InferenceSession>;

/**
 * Builds every session made from bytes on `factory` through splitWeights.
 *
 * Transformers.js creates each of Whisper's sessions with
 * `InferenceSession.create(bytes, options)` on the same onnxruntime-web module
 * the worker imports, so patching `create` there reaches them without
 * changing how the library fetches or picks anything.
 */
export function loadWeightsExternally(factory: typeof InferenceSession) {
  const create = factory.create.bind(factory) as Create;

  factory.create = ((model: unknown, ...rest: unknown[]) => {
    // The other overloads (a URL, or bytes with an offset) aren't ones
    // Transformers.js uses.
    if (!(model instanceof Uint8Array) || rest.length > 1) {
      return create(model, ...rest);
    }
    const options = (rest[0] ?? {}) as InferenceSession.SessionOptions;
    const { graph } = splitWeights(model);
    return create(graph, {
      ...options,
      externalData: [
        ...(options.externalData ?? []),
        { path: WEIGHTS_PATH, data: model },
      ],
    });
  }) as typeof factory.create;
}
