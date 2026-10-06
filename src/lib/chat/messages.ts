/**
 * Message contracts shared between the main thread and worker.ts.
 *
 * Unlike speech-to-text's, this protocol carries a progress message. The
 * `stage` responses aren't byte counts — the service worker still broadcasts
 * those — but which phase of a generate call is being waited on, which nothing
 * outside the worker can see.
 */

import type { ChatMessage, GenerateStage, SamplerParams } from './types';

/**
 * Defaults are resolved by index.ts before anything is posted, so every field
 * the worker reads is already concrete. There is deliberately no second copy of
 * the defaults on the far side of the channel.
 *
 * `onStage` and `onChunk` are the options that can't come along: a function
 * isn't structured-cloneable, so they stay on the main thread and the worker
 * reports stages and chunks by request id instead. See ./client.ts.
 */
export type ChatRequest =
  | {
      mode: 'generate';
      /** Omitted for the opening message — see the note in worker.ts. */
      prompt?: string;
      /** The opening message's stand-in for `prompt`, if any. */
      trigger?: string;
      systemInstruction?: string;
      history: ChatMessage[];
      modelUrl: string;
      maxNumTokens: number;
      samplerParams: SamplerParams;
    }
  | { mode: 'preload'; modelUrl: string }
  | { mode: 'preload-runtime' }
  | { mode: 'end-conversation' };

export type WorkerRequest = ChatRequest & { id: number };

export type WorkerResponse =
  | { id: number; type: 'stage'; stage: GenerateStage }
  /** Generate only: the next piece of the reply, as it's decoded. */
  | { id: number; type: 'chunk'; text: string }
  | { id: number; type: 'done'; text?: string }
  | { id: number; type: 'error'; message: string };
