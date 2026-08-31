/**
 * Text generation via Google's LiteRT-LM web SDK, running Gemma 4 (text-only,
 * "lean" build) locally in the browser via WebGPU.
 *
 * Docs: https://developers.google.com/edge/litert-lm/js
 * Package: @litert-lm/core (early preview — text-in / text-out only)
 */

import type {
  Engine,
  EngineSettings,
  ConversationConfig,
} from '@litert-lm/core';
import { fetchModelAsBlob } from './model-cache';
import type { ProgressCallback } from '../progress';

/** A single turn of prior conversation history to seed context with. */
export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

/**
 * Sampling/decoding parameters. Without these, the engine defaults to greedy
 * decoding (always picking the single most likely token), which is why
 * output is fully deterministic until you set these explicitly.
 */
export interface SamplerParams {
  /** Higher = more random/creative, lower = more focused/deterministic. Try 0.6–1.0 for chat. */
  temperature?: number;
  /** Only sample from the top K most likely tokens at each step. Try 20–64. */
  topK?: number;
  /** Nucleus sampling: only sample from tokens covering this cumulative probability. Try 0.9–0.97. */
  topP?: number;
  /** Optional seed for reproducible sampling (omit for non-reproducible randomness). */
  randomSeed?: number;
}

export interface GenerateMessageOptions {
  /**
   * The user's message content for this turn. Omit this to generate an
   * opening message driven purely by the system instruction — e.g. the very
   * first message in a new chat, before the user has typed anything.
   */
  prompt?: string;
  /** System-level instruction that sets the assistant's behavior/persona. */
  systemInstruction?: string;
  /**
   * Prior turns to give the model context, in chronological order. Include
   * every turn so far, since each call is stateless and only sees what you
   * pass in here.
   */
  history?: ChatMessage[];
  /** URL of the .litertlm model file. Defaults to MODELS.e4b. */
  modelUrl?: string;
  /** Max context window tokens for the engine. Defaults to 8192. */
  maxNumTokens?: number;
  /**
   * Sampling parameters controlling randomness. Defaults to a general-purpose
   * chat preset (temperature 0.8, topK 40, topP 0.95) rather than greedy
   * decoding.
   */
  samplerParams?: SamplerParams;
}

const DEFAULT_SAMPLER_PARAMS: Required<Omit<SamplerParams, 'randomSeed'>> = {
  temperature: 0.8,
  topK: 40,
  topP: 0.95,
};

export const MODELS = {
  /** Lower-end devices — smaller/faster, less capable. */
  e2b: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  /** Default — better output quality, for devices that can handle it. */
  e4b: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
};

// The engine (and its loaded model weights) is expensive to create, so we
// cache one instance per distinct modelUrl/maxNumTokens combination and
// reuse it across calls to generateMessage() within the current page load.
const enginePromises = new Map<string, Promise<Engine>>();

function getEngine(
  modelUrl: string,
  maxNumTokens: number,
  onProgress?: ProgressCallback,
): Promise<Engine> {
  const key = `${modelUrl}::${maxNumTokens}`;
  let promise = enginePromises.get(key);
  if (!promise) {
    promise = (async () => {
      const [modelBlob, { Engine: LiteRTEngine }] = await Promise.all([
        fetchModelAsBlob(modelUrl, onProgress),
        import('@litert-lm/core'),
      ]);
      const settings: EngineSettings = {
        model: modelBlob,
        mainExecutorSettings: { maxNumTokens },
      };
      return LiteRTEngine.create(settings);
    })();
    enginePromises.set(key, promise);
  }
  return promise;
}

/**
 * Generate the next model response, optionally grounded with a system
 * instruction and prior chat history.
 *
 * Call this two ways:
 * 1. Opening message: `generateMessage({ systemInstruction })` — no
 *    `prompt`/`history` yet, since the user hasn't said anything.
 * 2. Follow-up turns: `generateMessage({ prompt: userText, systemInstruction,
 *    history })` — pass the full running history so the model has context.
 *
 * Each call creates a fresh Conversation seeded with the supplied history,
 * so this function is stateless between calls — callers own the history.
 */
export async function generateMessage({
  prompt,
  systemInstruction,
  history = [],
  modelUrl = MODELS.e4b,
  maxNumTokens = 8192,
  samplerParams,
}: GenerateMessageOptions = {}): Promise<string> {
  const engine = await getEngine(modelUrl, maxNumTokens);

  const prefaceMessages: Array<{
    role: 'system' | 'user' | 'model';
    content: string;
  }> = [];
  if (systemInstruction) {
    prefaceMessages.push({ role: 'system', content: systemInstruction });
  }
  for (const turn of history) {
    prefaceMessages.push({ role: turn.role, content: turn.content });
  }

  const mergedSamplerParams = { ...DEFAULT_SAMPLER_PARAMS, ...samplerParams };

  const conversationConfig: ConversationConfig = {
    preface: { messages: prefaceMessages },
    // NOTE: `samplerParams` is not yet documented on the official JS API page
    // (as of writing the docs only show `preface`), but the underlying
    // engine's SessionConfig — which every platform binding maps onto —
    // carries an equivalent field. If your installed version of
    // @litert-lm/core uses a different key, check the shipped type defs.
    samplerParams: mergedSamplerParams,
  } as ConversationConfig;

  const conversation = await engine.createConversation(conversationConfig);

  try {
    // The SDK requires an outbound message to elicit a response — there's no
    // documented "generate from the preface alone" call. When `prompt` is
    // omitted (the opening-message case), we send an empty trigger turn; the
    // system instruction should describe what that first message should say.
    // This trigger is NOT part of `history` — don't store it as a real turn.
    const response = await conversation.sendMessage({
      role: 'user',
      content: prompt ?? '',
    });
    return extractText(response);
  } finally {
    const maybeDeletable = conversation as unknown as {
      delete?: () => Promise<void> | void;
    };
    if (typeof maybeDeletable.delete === 'function') {
      await maybeDeletable.delete();
    }
  }
}

// The exact shape of the response Message object isn't fully pinned down in
// the (early preview) public docs, so this extracts text defensively across
// a couple of plausible shapes rather than assuming one.
function extractText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message && typeof message === 'object') {
    const anyMsg = message as Record<string, unknown>;
    if (typeof anyMsg.text === 'string') return anyMsg.text;
    if (Array.isArray(anyMsg.content)) {
      return anyMsg.content
        .map((part) =>
          typeof part === 'object' && part && 'text' in part
            ? String((part as { text: unknown }).text ?? '')
            : '',
        )
        .join('');
    }
    if (typeof anyMsg.content === 'string') return anyMsg.content;
  }
  return String(message ?? '');
}

/**
 * Kicks off model download + engine initialization ahead of time, so the
 * first call to generateMessage() doesn't pay that cost. Safe to call
 * multiple times — getEngine() memoizes by modelUrl::maxNumTokens.
 */
export function preload(
  onProgress?: ProgressCallback,
  modelUrl: string = MODELS.e4b,
  maxNumTokens = 8192,
): Promise<Engine> {
  return getEngine(modelUrl, maxNumTokens, onProgress);
}

/**
 * Releases the cached engine(s) and their underlying model weights/resources.
 * A fresh engine will be lazily created again on the next generateMessage() call.
 */
export async function dispose(): Promise<void> {
  const promises = Array.from(enginePromises.values());
  enginePromises.clear();
  for (const enginePromise of promises) {
    const engine = await enginePromise;
    const maybeDeletable = engine as unknown as {
      delete?: () => Promise<void> | void;
    };
    if (typeof maybeDeletable.delete === 'function') {
      await maybeDeletable.delete();
    }
  }
}

export { clearModelCache } from './model-cache';
