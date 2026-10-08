export interface TranscribeOptions {
  /**
   * Source language. Pass 'english' or 'spanish' to force that language
   * (recommended — it's faster and more accurate than auto-detection).
   * Omit to let Whisper auto-detect the language instead.
   */
  language?: 'english' | 'spanish' | (string & {});
  /** 'transcribe' keeps original language; 'translate' converts to English. */
  task?: 'transcribe' | 'translate';
}
