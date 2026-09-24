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

import type { Conversation, ConversationConfig } from '@litert-lm/core';
import {
  dispose,
  extractText,
  getEngine,
  preloadModel,
  preloadRuntime,
} from './engine';
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
 */
interface ActiveConversation {
  conversation: Conversation;
  /** What it was created with, as `settingsKey` gives it. */
  settings: string;
  /** The history it holds, as callers see it. */
  history: ChatMessage[];
}

let active: ActiveConversation | null = null;

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

  // No sampler settings: `request.samplerParams` stops here. The library only
  // reads them from `sessionConfig.samplerParams`, and anything above top-1
  // there fails outright — "Top-K value 40 must be <= 1" — because the WebGPU
  // backend (GPU_ARTISAN) is created with `max_top_k` 1. So the engine decodes
  // greedily, as it always has here: passed at the top level, as they once
  // were, the library ignored them without a word.
  return { preface: { messages } };
}

async function generate(
  request: GenerateRequest,
  onStage: (stage: GenerateStage) => void,
  onChunk: (text: string) => void,
): Promise<string> {
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
    // omitted (the opening-message case), we send an empty trigger turn; the
    // system instruction should describe what that first message should say.
    // This trigger is NOT part of `history` — don't store it as a real turn.
    //
    // Streamed, so the reply can be passed on a piece at a time while the rest
    // is still decoding. Each chunk is new text only, not the reply so far.
    const reader = conversation
      .sendMessageStreaming({ role: 'user', content: request.prompt ?? '' })
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

  // Kept for the next turn, which will pass this same history back. An opening
  // message's empty trigger stays in the conversation but out of this record,
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
      case 'dispose':
        // Before the engines it belongs to.
        await dropActive();
        await dispose();
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
