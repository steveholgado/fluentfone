import { VOICES } from '#/lib/text-to-speech';
import type { CefrLevel } from '#/prompts';

/**
 * The languages on offer. `transcription` is what Whisper is told to expect,
 * which can't tell regional variants apart, so they share one.
 */
export const LANGUAGES = {
  'es-ES': {
    label: 'Spanish (Spain)',
    transcription: 'spanish',
    voiceIds: VOICES.es_ES,
  },
  'es-MX': {
    label: 'Spanish (Mexico)',
    transcription: 'spanish',
    voiceIds: VOICES.es_MX,
  },
} as const;

export type LanguageId = keyof typeof LANGUAGES;

export const DEFAULT_LANGUAGE: LanguageId = 'es-ES';

/** The voice a call speaks with: its pack's first. */
export function voiceFor(language: LanguageId): string {
  return LANGUAGES[language].voiceIds[0];
}

export const DEFAULT_LEVEL: CefrLevel = 'B1';

/** How fast the partner speaks, relative to the voice's natural pace. */
export const SPEEDS = [
  { value: 0.5, label: 'Slow' },
  { value: 0.75, label: 'Relaxed' },
  { value: 1, label: 'Natural' },
] as const;

export type Speed = (typeof SPEEDS)[number]['value'];

/** Where each level starts: slower for beginners, who are still tuning in. */
export const DEFAULT_SPEED: Record<CefrLevel, Speed> = {
  A1: 0.5,
  A2: 0.75,
  B1: 1,
  B2: 1,
};
