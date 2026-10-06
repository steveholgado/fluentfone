/**
 * The main thread's end of the channel to worker.ts: one long-lived worker,
 * requests matched to replies by id.
 *
 * Kept for the whole page session, not just for one call as text-to-speech's
 * voices are, because keeping a compiled engine resident is the whole point of
 * the worker — terminating between calls would throw away the minutes of model
 * compile this exists to keep off the main thread in the first place.
 */

import type { ChatRequest, WorkerRequest, WorkerResponse } from './messages';
import type { GenerateStage } from './types';

/**
 * Held here rather than posted. A function can't be structured-cloned, so the
 * worker reports stages and chunks by id and this is where they are routed
 * back to.
 */
export interface RequestCallbacks {
  onStage?: (stage: GenerateStage) => void;
  onChunk?: (text: string) => void;
}

interface PendingRequest extends RequestCallbacks {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

// Created lazily (not at module scope) since this module is also evaluated
// during prerendering, where `Worker` doesn't exist.
let worker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, PendingRequest>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'chat',
    });

    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const request = pending.get(message.id);
        if (!request) return;

        // Stages and chunks aren't terminal: more (and eventually a 'done')
        // follow, so the pending entry stays put.
        if (message.type === 'stage') {
          request.onStage?.(message.stage);
        } else if (message.type === 'chunk') {
          request.onChunk?.(message.text);
        } else if (message.type === 'done') {
          pending.delete(message.id);
          request.resolve(message.text ?? '');
        } else {
          pending.delete(message.id);
          request.reject(new Error(message.message));
        }
      },
    );

    worker.addEventListener('error', (event) => {
      const err = new Error(event.message || 'Chat worker failed.');
      for (const request of pending.values()) request.reject(err);
      pending.clear();
    });
  }
  return worker;
}

/**
 * Posts one request and resolves with whatever text comes back — the empty
 * string for the requests that produce none.
 */
export function send(
  request: ChatRequest,
  callbacks: RequestCallbacks = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { resolve, reject, ...callbacks });
    getWorker().postMessage({ ...request, id } as WorkerRequest);
  });
}
