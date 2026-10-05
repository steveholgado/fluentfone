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
 * That alone isn't enough. ORT's constant folding evaluates any node whose
 * inputs are all weights, on the CPU, in the heap: it reads the weight in and
 * writes the result there too. Whisper's q4 decoder has exactly one such node,
 * twice over: the output projection transposes the full-precision token
 * embedding (51865 × 768 fp32, 159 MB), once in each branch of its `If`. Folded
 * by ORT, those cost ~480 MB of heap; left unfolded, the GPU transposes 159 MB
 * on every decoder step, ~40% slower per utterance. So this folds them itself:
 * the transposed weight is computed here, in JS, and handed over as a second
 * external file, and one initializer in the main graph stands in for both
 * nodes, which leaves ORT nothing large to fold.
 *
 * Switched by EXTERNAL_WEIGHTS in constants.ts.
 */

import type { InferenceSession } from 'onnxruntime-web/webgpu';

/** The name the rewritten graph gives the original file, and ORT is given it under. */
const WEIGHTS_PATH = 'weights';

/** Likewise for the file of weights this transposes ahead of ORT. */
const TRANSPOSED_PATH = 'transposed';

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
const NODE_INPUT = 1;
const NODE_OUTPUT = 2;
const NODE_OP_TYPE = 4;
const NODE_ATTRIBUTE = 5;
const ATTRIBUTE_NAME = 1;
const ATTRIBUTE_GRAPH = 6;
const ATTRIBUTE_INTS = 8;
const ATTRIBUTE_GRAPHS = 11;
const TENSOR_DIMS = 1;
const TENSOR_DATA_TYPE = 2;
const TENSOR_NAME = 8;
const TENSOR_RAW_DATA = 9;
const TENSOR_EXTERNAL_DATA = 13;
const TENSOR_DATA_LOCATION = 14;
const ENTRY_KEY = 1;
const ENTRY_VALUE = 2;
const DATA_LOCATION_EXTERNAL = 1;

/**
 * Bytes per element of the ONNX data types a weight to be transposed may
 * have, keyed by `TensorProto.DataType`. Wider types aren't worth the code:
 * ORT folds those itself.
 */
const ELEMENT_BYTES: Record<number, 1 | 2 | 4> = {
  1: 4, // FLOAT
  2: 1, // UINT8
  3: 1, // INT8
  4: 2, // UINT16
  5: 2, // INT16
  6: 4, // INT32
  9: 1, // BOOL
  10: 2, // FLOAT16
  12: 4, // UINT32
  16: 2, // BFLOAT16
};

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
  /** Where the field's value starts: after the length, if it has one. */
  dataStart: number;
  end: number;
}

/** A weight large enough to move out of the graph, as it sits in the file. */
interface Weight {
  dims: number[];
  dataType: number;
  start: number;
  length: number;
}

/** A Transpose of a weight, done here rather than by ORT. */
interface Fold {
  source: string;
  weight: Weight;
  /** Where the result starts in TRANSPOSED_PATH. */
  offset: number;
}

interface Transpose {
  input: string;
  output: string;
  perm: number[] | undefined;
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

function readString(bytes: Uint8Array, field: Field): string {
  return new TextDecoder().decode(bytes.subarray(field.dataStart, field.end));
}

/** A repeated integer field's values in this occurrence, packed or not. */
function readInts(bytes: Uint8Array, field: Field): number[] {
  if (field.wireType === VARINT) return [readVarint(bytes, field.dataStart)[0]];
  const values: number[] = [];
  for (let pos = field.dataStart; pos < field.end;) {
    let value;
    [value, pos] = readVarint(bytes, pos);
    values.push(value);
  }
  return values;
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

function lengthDelimited(
  number: number,
  payload: Uint8Array | string,
): Uint8Array {
  const bytes =
    typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return concat([varint(number * 8 + LEN), varint(bytes.length), bytes]);
}

function varintField(number: number, value: number): Uint8Array {
  return concat([varint(number * 8 + VARINT), varint(value)]);
}

/** The TensorProto fields that say its data is `length` bytes at `offset` in `location`. */
function externalDataFields(
  location: string,
  offset: number,
  length: number,
): Uint8Array[] {
  return [
    ...Object.entries({ location, offset, length }).map(([key, value]) =>
      lengthDelimited(
        TENSOR_EXTERNAL_DATA,
        concat([
          lengthDelimited(ENTRY_KEY, key),
          lengthDelimited(ENTRY_VALUE, String(value)),
        ]),
      ),
    ),
    varintField(TENSOR_DATA_LOCATION, DATA_LOCATION_EXTERNAL),
  ];
}

/** The weight a TensorProto holds, if it's large enough to move. */
function readWeight(
  bytes: Uint8Array,
  start: number,
  end: number,
): { name: string; weight: Weight } | undefined {
  let name = '';
  const dims: number[] = [];
  let dataType = 0;
  let raw: Field | undefined;
  for (const field of fields(bytes, start, end)) {
    if (field.number === TENSOR_NAME) name = readString(bytes, field);
    if (field.number === TENSOR_DIMS) dims.push(...readInts(bytes, field));
    if (field.number === TENSOR_DATA_TYPE) dataType = readInts(bytes, field)[0];
    if (field.number === TENSOR_RAW_DATA && field.wireType === LEN) raw = field;
  }
  const length = raw ? raw.end - raw.dataStart : 0;
  if (!raw || length < MIN_EXTERNAL_BYTES) return undefined;
  return { name, weight: { dims, dataType, start: raw.dataStart, length } };
}

/** The node, if it's a Transpose with one input and one output. */
function readTranspose(
  bytes: Uint8Array,
  start: number,
  end: number,
): Transpose | undefined {
  let op = '';
  const inputs: string[] = [];
  const outputs: string[] = [];
  let perm: number[] | undefined;
  for (const field of fields(bytes, start, end)) {
    if (field.number === NODE_OP_TYPE) op = readString(bytes, field);
    if (field.number === NODE_INPUT) inputs.push(readString(bytes, field));
    if (field.number === NODE_OUTPUT) outputs.push(readString(bytes, field));
    if (field.number === NODE_ATTRIBUTE) {
      let name = '';
      const ints: number[] = [];
      for (const attribute of fields(bytes, field.dataStart, field.end)) {
        if (attribute.number === ATTRIBUTE_NAME) {
          name = readString(bytes, attribute);
        }
        if (attribute.number === ATTRIBUTE_INTS) {
          ints.push(...readInts(bytes, attribute));
        }
      }
      if (name === 'perm') perm = ints;
    }
  }
  if (op !== 'Transpose' || inputs.length !== 1 || outputs.length !== 1) {
    return undefined;
  }
  return { input: inputs[0], output: outputs[0], perm };
}

/**
 * Collects every movable weight and every Transpose, in subgraphs too. A name
 * used for two weights (in different subgraphs) maps to null: it can't be
 * told which one a node means.
 */
function scan(
  bytes: Uint8Array,
  start: number,
  end: number,
  message: Message,
  weights: Map<string, Weight | null>,
  transposes: Transpose[],
) {
  for (const field of fields(bytes, start, end)) {
    const child =
      field.wireType === LEN ? CHILDREN[message][field.number] : undefined;
    if (child === 'tensor') {
      const found = readWeight(bytes, field.dataStart, field.end);
      if (found) {
        weights.set(found.name, weights.has(found.name) ? null : found.weight);
      }
    } else if (child) {
      if (child === 'node') {
        const transpose = readTranspose(bytes, field.dataStart, field.end);
        if (transpose) transposes.push(transpose);
      }
      scan(bytes, field.dataStart, field.end, child, weights, transposes);
    }
  }
}

/**
 * The Transposes to do here, keyed by output name: those of a 2-D weight
 * (with the default `perm`, or [1, 0]). Nodes that share an output name, as
 * the decoder's two branches do, share one result, provided they transpose
 * the same weight.
 */
function planFolds(
  weights: Map<string, Weight | null>,
  transposes: Transpose[],
): { folds: Map<string, Fold>; length: number } {
  const folds = new Map<string, Fold>();
  const conflicting = new Set<string>();
  for (const { input, output, perm } of transposes) {
    const weight = weights.get(input);
    const swapsAxes = !perm || (perm[0] === 1 && perm[1] === 0);
    if (
      !weight ||
      weight.dims.length !== 2 ||
      !swapsAxes ||
      !ELEMENT_BYTES[weight.dataType] ||
      weight.dims[0] * weight.dims[1] * ELEMENT_BYTES[weight.dataType] !==
        weight.length
    ) {
      continue;
    }
    const existing = folds.get(output);
    if (existing && existing.source !== input) conflicting.add(output);
    folds.set(output, { source: input, weight, offset: 0 });
  }
  for (const output of conflicting) folds.delete(output);

  let length = 0;
  for (const fold of folds.values()) {
    fold.offset = length;
    // Each result starts element-aligned, so it can be written through a
    // typed array.
    length += Math.ceil(fold.weight.length / 4) * 4;
  }
  return { folds, length };
}

/** Writes `weight` transposed into `out` at `offset`. */
function transpose(
  bytes: Uint8Array,
  weight: Weight,
  out: Uint8Array,
  offset: number,
) {
  const [rows, cols] = weight.dims;
  const size = ELEMENT_BYTES[weight.dataType];
  const View: new (
    buffer: ArrayBufferLike,
    byteOffset: number,
    length: number,
  ) => Record<number, number> =
    size === 4 ? Uint32Array : size === 2 ? Uint16Array : Uint8Array;
  let source = bytes.subarray(weight.start, weight.start + weight.length);
  // A typed array over the file needs the weight to start element-aligned,
  // which nothing in the format promises.
  if (source.byteOffset % size !== 0) source = source.slice();
  const from = new View(source.buffer, source.byteOffset, rows * cols);
  const to = new View(out.buffer, out.byteOffset + offset, rows * cols);

  // In tiles, so that both sides stay in cache.
  const TILE = 64;
  for (let r0 = 0; r0 < rows; r0 += TILE) {
    const rEnd = Math.min(r0 + TILE, rows);
    for (let c0 = 0; c0 < cols; c0 += TILE) {
      const cEnd = Math.min(c0 + TILE, cols);
      for (let r = r0; r < rEnd; r++) {
        for (let c = c0; c < cEnd; c++) to[c * rows + r] = from[r * cols + c];
      }
    }
  }
}

/** A TensorProto for a fold's result, with its data in TRANSPOSED_PATH. */
function foldedTensor(output: string, fold: Fold): Uint8Array {
  const [rows, cols] = fold.weight.dims;
  return concat([
    varintField(TENSOR_DIMS, cols),
    varintField(TENSOR_DIMS, rows),
    varintField(TENSOR_DATA_TYPE, fold.weight.dataType),
    lengthDelimited(TENSOR_NAME, output),
    ...externalDataFields(TRANSPOSED_PATH, fold.offset, fold.weight.length),
  ]);
}

/**
 * A TensorProto with its `raw_data` swapped for where those bytes sit in the
 * file, or the tensor as it was if it's too small to bother.
 */
function rewriteTensor(
  bytes: Uint8Array,
  start: number,
  end: number,
): { body: Uint8Array; moved: number } {
  const found = readWeight(bytes, start, end);
  if (!found) return { body: bytes.subarray(start, end), moved: 0 };

  const parts: Uint8Array[] = [];
  for (const field of fields(bytes, start, end)) {
    if (
      field.number !== TENSOR_RAW_DATA &&
      field.number !== TENSOR_DATA_LOCATION
    ) {
      parts.push(bytes.subarray(field.start, field.end));
    }
  }
  const { start: offset, length } = found.weight;
  parts.push(...externalDataFields(WEIGHTS_PATH, offset, length));
  return { body: concat(parts), moved: length };
}

function rewriteMessage(
  bytes: Uint8Array,
  start: number,
  end: number,
  message: Message,
  folds: Map<string, Fold>,
  isMainGraph = false,
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
    if (child === 'node') {
      // A folded Transpose goes: the main graph's initializer replaces it.
      const node = readTranspose(bytes, field.dataStart, field.end);
      if (node && folds.get(node.output)?.source === node.input) continue;
    }
    const rewritten =
      child === 'tensor'
        ? rewriteTensor(bytes, field.dataStart, field.end)
        : rewriteMessage(
            bytes,
            field.dataStart,
            field.end,
            child,
            folds,
            message === 'model',
          );
    parts.push(lengthDelimited(field.number, rewritten.body));
    moved += rewritten.moved;
  }
  // In the main graph, the folds' results are in scope in every subgraph.
  if (isMainGraph) {
    for (const [output, fold] of folds) {
      parts.push(
        lengthDelimited(GRAPH_INITIALIZER, foldedTensor(output, fold)),
      );
    }
  }
  return { body: concat(parts), moved };
}

/**
 * Rewrites an ONNX model so that every weight of MIN_EXTERNAL_BYTES or more
 * is external data in WEIGHTS_PATH, at the offset its bytes already have in
 * `model`, and every Transpose of such a weight is done ahead of time into
 * TRANSPOSED_PATH. `externalData` is the files to hand ORT with the graph.
 */
export function splitWeights(model: Uint8Array): {
  graph: Uint8Array;
  externalData: { path: string; data: Uint8Array }[];
  /** How many bytes of weights the graph now points at instead of holding. */
  moved: number;
} {
  const weights = new Map<string, Weight | null>();
  const transposes: Transpose[] = [];
  scan(model, 0, model.length, 'model', weights, transposes);
  const { folds, length } = planFolds(weights, transposes);

  const externalData = [{ path: WEIGHTS_PATH, data: model }];
  if (folds.size > 0) {
    const transposed = new Uint8Array(length);
    for (const fold of folds.values()) {
      transpose(model, fold.weight, transposed, fold.offset);
    }
    externalData.push({ path: TRANSPOSED_PATH, data: transposed });
  }

  const { body, moved } = rewriteMessage(
    model,
    0,
    model.length,
    'model',
    folds,
  );
  return { graph: body, externalData, moved };
}

type Create = (model: unknown, ...rest: unknown[]) => Promise<InferenceSession>;

/**
 * Frees `bytes` now rather than at the worker's next garbage collection, by
 * detaching its buffer. Once Whisper is built the worker sits idle, and an
 * idle worker isn't collected until something prompts it: its ~570 MB of
 * model files and transposed weights stayed on the tab's footprint, on top of
 * the chat engine, until then.
 *
 * Only a view that spans its whole buffer: anything less shares the buffer
 * with bytes this doesn't own. `transfer` is ES2024, so where it is missing
 * the bytes are left to the collector as before.
 */
function release(bytes: Uint8Array) {
  const buffer = bytes.buffer as ArrayBufferLike & {
    transfer?: (length: number) => ArrayBuffer;
  };
  if (
    buffer.byteLength === 0 ||
    bytes.byteOffset !== 0 ||
    bytes.byteLength !== buffer.byteLength
  ) {
    return;
  }
  buffer.transfer?.(0);
}

/**
 * Builds every session made from bytes on `factory` through splitWeights.
 *
 * Transformers.js creates each of Whisper's sessions with
 * `InferenceSession.create(bytes, options)` on the same onnxruntime-web module
 * the worker imports, so patching `create` there reaches them without
 * changing how the library fetches or picks anything.
 *
 * Once a session is built, the bytes it was built from are released: ORT has
 * copied the graph into its heap and the weights to the GPU by then, and
 * Transformers.js keeps no reference to the file it fetched. Anything that
 * did read them afterwards would find them detached and fail, rather than
 * read the wrong bytes.
 */
export function loadWeightsExternally(factory: typeof InferenceSession) {
  const create = factory.create.bind(factory) as Create;

  factory.create = (async (model: unknown, ...rest: unknown[]) => {
    // The other overloads (a URL, or bytes with an offset) aren't ones
    // Transformers.js uses.
    if (!(model instanceof Uint8Array) || rest.length > 1) {
      return create(model, ...rest);
    }
    const options = (rest[0] ?? {}) as InferenceSession.SessionOptions;
    const { graph, externalData } = splitWeights(model);
    try {
      return await create(graph, {
        ...options,
        externalData: [...(options.externalData ?? []), ...externalData],
      });
    } finally {
      // Not the caller's own external data, which isn't ours to free. The
      // model is among `externalData` too, hence the set.
      const ours = new Set([model, graph, ...externalData.map((f) => f.data)]);
      for (const bytes of ours) release(bytes);
    }
  }) as typeof factory.create;
}
