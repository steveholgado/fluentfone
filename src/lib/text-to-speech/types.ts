export interface SpeakOptions {
  /**
   * Pace relative to the voice's own, where 1 is natural and 0.5 is half as
   * fast.
   */
  speed?: number;
  /** Called once the audio is back, with where its time went. */
  onTimings?: (timings: SpeakTimings) => void;
}

/** Durations in milliseconds. */
export interface SpeakTimings {
  /**
   * Everything but synthesis: waiting on the voice's session if it's still
   * loading, waiting behind lines sent before this one, and the messaging
   * either side. Near zero for a first line once the voice is warm.
   */
  startup: number;
  /**
   * Synthesis alone, inside the worker: phonemizing, running the model, and
   * encoding the WAV.
   */
  synthesis: number;
}
