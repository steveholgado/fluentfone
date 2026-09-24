export interface TranscribeOptions {
  /**
   * Source language. Pass 'english' or 'spanish' to force that language
   * (recommended — it's faster and more accurate than auto-detection).
   * Omit to let Whisper auto-detect the language instead.
   */
  language?: 'english' | 'spanish' | (string & {});
  /** 'transcribe' keeps original language; 'translate' converts to English. */
  task?: 'transcribe' | 'translate';
  /** Called once the transcription is back, with where its time went. */
  onTimings?: (timings: TranscribeTimings) => void;
}

/** Durations in milliseconds. */
export interface TranscribeTimings {
  /** Decoding and resampling the recording, on the main thread. */
  decode: number;
  /** The Whisper pipeline call alone, inside the worker. */
  inference: number;
  /** Which backend the pipeline was built on. */
  device: TranscribeDevice;
}

export type TranscribeDevice = 'webgpu' | 'wasm';
