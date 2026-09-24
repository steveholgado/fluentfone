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
   * Everything before synthesis: spawning the worker, loading its modules and
   * creating the TtsSession. Paid on every call while each call gets a fresh
   * worker.
   */
  startup: number;
  /** The `predict()` call alone, inside the worker. */
  synthesis: number;
}
