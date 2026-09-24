export interface SpeakOptions {
  /**
   * Synthesize at a slower pace, for repeating a line. Relies on the
   * piper-tts-web patch; without it the speech plays at normal speed.
   */
  slow?: boolean;
}
