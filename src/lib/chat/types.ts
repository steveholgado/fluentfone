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
  /**
   * Only sample from the top K most likely tokens at each step. Try 20–64; at
   * most MAX_TOP_K, which the engine is created with.
   */
  topK?: number;
  /** Nucleus sampling: only sample from tokens covering this cumulative probability. Try 0.9–0.97. */
  topP?: number;
  /**
   * Optional seed for reproducible sampling. Omit it for a fresh random seed
   * per conversation — the engine's own default is fixed, which would make
   * every conversation sample the same way.
   */
  randomSeed?: number;
}

export interface GenerateMessageOptions {
  /**
   * The user's message content for this turn. Omit this to generate an
   * opening message — e.g. the very first message in a new chat, before the
   * user has typed anything — steered by `trigger`, if given.
   */
  prompt?: string;
  /**
   * For an opening message only (no `prompt`): what the model is told to do,
   * sent in the user's place. It stays in the model's context but out of the
   * history, so the caller leaves it out of the history it passes next time
   * too. Without it, the opening message is driven by the system instruction
   * alone. Ignored when `prompt` is given.
   */
  trigger?: string;
  /** System-level instruction that sets the assistant's behavior/persona. */
  systemInstruction?: string;
  /**
   * Prior turns to give the model context, in chronological order. Include
   * every turn so far: each call only sees what you pass in here. (When it
   * matches what the worker's kept conversation already holds, the model
   * doesn't have to read it again — see `generateMessage`.)
   */
  history?: ChatMessage[];
  /** URL of the .litertlm model file. */
  modelUrl?: string;
  /** Max context window tokens for the engine. Defaults to 8192. */
  maxNumTokens?: number;
  /**
   * Sampling parameters controlling randomness. Defaults to a general-purpose
   * chat preset (temperature 0.8, topK 40, topP 0.95) rather than greedy
   * decoding.
   */
  samplerParams?: SamplerParams;
  /**
   * Called as the call moves between phases, so the UI can say which one it is
   * waiting on instead of showing one undifferentiated wait.
   *
   * Preload normally gets the model and the wasm runtime onto disk ahead of
   * time, so the usual sequence is 'loading' (reading the file back off disk),
   * 'compiling', 'generating'. 'downloading' appears in its place only when
   * the bytes really are being fetched — a first run that skipped preload, or
   * a browser that has evicted them since.
   */
  onStage?: (stage: GenerateStage) => void;
  /**
   * Called with each new piece of the reply as it's decoded — new text only,
   * not the reply so far — so a caller can act on the start of a reply before
   * the end exists. The returned promise still resolves with the whole reply.
   */
  onChunk?: (text: string) => void;
}

export type GenerateStage =
  'downloading' | 'loading' | 'compiling' | 'generating';
