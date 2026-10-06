/**
 * Runs Gemma through LiteRT-LM off the main thread.
 *
 * Like speech-to-text's worker and unlike text-to-speech's, this one is
 * long-lived and reused across requests: ./engine.ts keeps a compiled engine
 * resident in this worker's memory, and rebuilding it per call would cost
 * minutes.
 *
 * What moving here buys is responsiveness rather than throughput — decode is
 * GPU-bound and the library runs single-threaded wherever it is called from.
 * The main-thread work it takes away is real, though, and most of it is in
 * `Engine.create()`: the default GPU_ARTISAN backend stream-loads the model by
 * copying it chunk by chunk into the wasm heap from JS, and on browsers without
 * JSPI the library loads its Asyncify build, whose unwind/rewind overhead lands
 * on the calling thread too.
 *
 * WebGPU needs no main-thread privileges here — the engine only computes, so
 * `navigator.gpu` in a dedicated worker is enough and no canvas is involved.
 */

import type {
  Conversation,
  ConversationConfig,
  SamplerType,
} from '@litert-lm/core';
import { extractText, getEngine, preloadModel, preloadRuntime } from './engine';
import { installClassicScriptLoader } from './import-scripts';
import type { WorkerRequest, WorkerResponse } from './messages';
import type { ChatMessage, GenerateStage } from './types';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage.
const ctx = self as unknown as Worker;

// Before anything can reach @litert-lm/core, which cannot load its wasm in a
// module worker unaided. Safe here rather than at an import: ./engine.ts only
// pulls the library in from inside its functions, and the handler below is
// registered after this runs.
installClassicScriptLoader();

type GenerateRequest = Extract<WorkerRequest, { mode: 'generate' }>;

// `SamplerType.TOP_P`, written out so that this module doesn't load the
// library at import time just to read an enum. Top-p here also applies `k`.
const TOP_P = 2 satisfies SamplerType;

/**
 * The conversation the last generate left behind, kept so the next turn can
 * send just its new message. A fresh conversation has to read the system
 * instruction and the whole history before it writes a word — measured at
 * ~165 ms more each turn, as the history grew.
 *
 * Callers still pass the full history every time; it's compared against what
 * this conversation already holds, and anything that doesn't match exactly —
 * another caller, a turn that failed, different settings — gets a fresh one
 * built from the history instead. So reuse is an optimisation the caller never
 * has to know about.
 *
 * Dropped early by an 'end-conversation' request, so that a call that has
 * ended doesn't go on holding memory until the next one's first generate.
 */
interface ActiveConversation {
  conversation: Conversation;
  /** What it was created with, as `settingsKey` gives it. */
  settings: string;
  /** The history it holds, as callers see it. */
  history: ChatMessage[];
}

let active: ActiveConversation | null = null;

/**
 * Counts 'end-conversation' requests. A generate can't be aborted, so one in
 * flight when its conversation is ended runs on; comparing this before and
 * after is how it knows not to keep what it built.
 */
let ended = 0;

function settingsKey(request: GenerateRequest): string {
  return JSON.stringify([
    request.modelUrl,
    request.maxNumTokens,
    request.systemInstruction ?? '',
    request.samplerParams,
  ]);
}

function sameHistory(a: ChatMessage[], b: ChatMessage[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (turn, i) => turn.role === b[i].role && turn.content === b[i].content,
    )
  );
}

async function deleteConversation(conversation: Conversation): Promise<void> {
  await (conversation as { delete?: () => Promise<void> | void }).delete?.();
}

/** Deletes the kept conversation, if any. The next generate builds afresh. */
async function dropActive(): Promise<void> {
  const dropped = active;
  active = null;
  if (dropped) await deleteConversation(dropped.conversation);
}

/**
 * A seed for a conversation that wasn't given one. The engine's own default
 * is fixed, so without this every conversation samples the same way — the
 * same input gives the same reply every time, just as greedy decoding did.
 * Drawn per conversation rather than per call, so that it's no part of what a
 * kept conversation is matched on. 31 bits, to fit the engine's signed int.
 */
function freshSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
}

function conversationConfig(request: GenerateRequest): ConversationConfig {
  const messages: Array<{
    role: 'system' | ChatMessage['role'];
    content: string;
  }> = [];
  if (request.systemInstruction) {
    messages.push({ role: 'system', content: request.systemInstruction });
  }
  for (const turn of request.history) {
    messages.push({ role: turn.role, content: turn.content });
  }

  const { temperature, topK, topP, randomSeed } = request.samplerParams;
  return {
    preface: { messages },
    // Under `sessionConfig`, in the library's own names. At the top level, as
    // they once were, the library ignored them and decoded greedily. `k` can
    // be at most the `max_top_k` the engine was created with — see
    // GPU_ARTISAN_CONFIG in ./engine.ts.
    sessionConfig: {
      samplerParams: {
        type: TOP_P,
        k: topK,
        p: topP,
        temperature,
        seed: randomSeed ?? freshSeed(),
      },
    },
  };
}

async function generate(
  request: GenerateRequest,
  onStage: (stage: GenerateStage) => void,
  onChunk: (text: string) => void,
): Promise<string> {
  const endedAtStart = ended;
  const engine = await getEngine(
    request.modelUrl,
    request.maxNumTokens,
    onStage,
  );

  const settings = settingsKey(request);
  let conversation: Conversation;
  if (
    active &&
    active.settings === settings &&
    sameHistory(active.history, request.history)
  ) {
    // Taken, not shared: it's put back below only if this turn succeeds.
    conversation = active.conversation;
    active = null;
  } else {
    await dropActive();
    conversation = await engine.createConversation(conversationConfig(request));
  }

  onStage('generating');

  let text = '';
  try {
    // The SDK requires an outbound message to elicit a response — there's no
    // documented "generate from the preface alone" call. When `prompt` is
    // omitted (the opening-message case), we send the caller's trigger in its
    // place — empty if there isn't one, leaving the system instruction to
    // describe what that first message should say. The trigger is NOT part of
    // `history` — don't store it as a real turn.
    //
    // Streamed, so the reply can be passed on a piece at a time while the rest
    // is still decoding. Each chunk is new text only, not the reply so far.
    const reader = conversation
      .sendMessageStreaming({
        role: 'user',
        content: request.prompt ?? request.trigger ?? '',
      })
      .getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = extractText(value);
      if (!piece) continue;
      text += piece;
      onChunk(piece);
    }
  } catch (err) {
    // Whatever it holds now is unknown, so it isn't kept.
    await deleteConversation(conversation);
    throw err;
  }

  // Ended while this was generating: the reply still goes back, but nothing
  // will carry on from it.
  if (ended !== endedAtStart) {
    await deleteConversation(conversation);
    return text;
  }

  // Kept for the next turn, which will pass this same history back. An opening
  // message's trigger stays in the conversation but out of this record,
  // just as it's out of the caller's history. Anything kept meanwhile, by a
  // generate that overlapped this one, is replaced.
  await dropActive();
  active = {
    conversation,
    settings,
    history: [
      ...request.history,
      ...(request.prompt === undefined
        ? []
        : [{ role: 'user' as const, content: request.prompt }]),
      { role: 'model', content: text },
    ],
  };

  return text;
}

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const { id } = request;

  try {
    switch (request.mode) {
      case 'generate': {
        const text = await generate(
          request,
          (stage) => {
            ctx.postMessage({
              id,
              type: 'stage',
              stage,
            } satisfies WorkerResponse);
          },
          (chunk) => {
            ctx.postMessage({
              id,
              type: 'chunk',
              text: chunk,
            } satisfies WorkerResponse);
          },
        );
        ctx.postMessage({ id, type: 'done', text } satisfies WorkerResponse);
        return;
      }
      case 'preload':
        await preloadModel(request.modelUrl);
        break;
      case 'preload-runtime':
        await preloadRuntime();
        break;
      case 'end-conversation':
        ended++;
        await dropActive();
        break;
    }

    ctx.postMessage({ id, type: 'done' } satisfies WorkerResponse);
  } catch (err) {
    ctx.postMessage({
      id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse);
  }
};
