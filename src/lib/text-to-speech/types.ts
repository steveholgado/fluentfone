export interface SpeakOptions {
  /**
   * Synthesize at a slower pace, for repeating a line. Relies on the
   * piper-tts-web patch; without it the speech plays at normal speed.
   */
  slow?: boolean;
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
  /** The `predict()` call alone, inside the worker. */
  synthesis: number;
}
