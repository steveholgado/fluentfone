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

import type { ConversationConfig } from '@litert-lm/core';
import {
  dispose,
  extractText,
  getEngine,
  preloadModel,
  preloadRuntime,
} from './engine';
import { installClassicScriptLoader } from './import-scripts';
import type { WorkerRequest, WorkerResponse } from './messages';
import type { GenerateStage } from './types';

// DOM lib doesn't type worker-global `self`; the shape matches Worker's
// instance side closely enough for postMessage.
const ctx = self as unknown as Worker;

// Before anything can reach @litert-lm/core, which cannot load its wasm in a
// module worker unaided. Safe here rather than at an import: ./engine.ts only
// pulls the library in from inside its functions, and the handler below is
// registered after this runs.
installClassicScriptLoader();

type GenerateRequest = Extract<WorkerRequest, { mode: 'generate' }>;

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

  const prefaceMessages: Array<{
    role: 'system' | 'user' | 'model';
    content: string;
  }> = [];
  if (request.systemInstruction) {
    prefaceMessages.push({
      role: 'system',
      content: request.systemInstruction,
    });
  }
  for (const turn of request.history) {
    prefaceMessages.push({ role: turn.role, content: turn.content });
  }

  const conversationConfig: ConversationConfig = {
    preface: { messages: prefaceMessages },
    // NOTE: `samplerParams` is not yet documented on the official JS API page
    // (as of writing the docs only show `preface`), but the underlying
    // engine's SessionConfig — which every platform binding maps onto —
    // carries an equivalent field. If your installed version of
    // @litert-lm/core uses a different key, check the shipped type defs.
    samplerParams: request.samplerParams,
  } as ConversationConfig;

  const conversation = await engine.createConversation(conversationConfig);

  onStage('generating');

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
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      const piece = extractText(value);
      if (!piece) continue;
      text += piece;
      onChunk(piece);
    }
  } finally {
    const maybeDeletable = conversation as unknown as {
      delete?: () => Promise<void> | void;
    };
    if (typeof maybeDeletable.delete === 'function') {
      await maybeDeletable.delete();
    }
  }
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
