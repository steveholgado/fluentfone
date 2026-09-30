import { VOICES } from '#/lib/text-to-speech';
import type { CefrLevel } from '#/prompts';

export const LANGUAGE = 'spanish';
export const VOICE_ID = VOICES.es;

export const DEFAULT_LEVEL: CefrLevel = 'B1';

/** How fast the partner speaks, relative to the voice's natural pace. */
export const SPEEDS = [
  { value: 0.7, label: 'Slow' },
  { value: 0.85, label: 'Relaxed' },
  { value: 1, label: 'Natural' },
] as const;

export type Speed = (typeof SPEEDS)[number]['value'];

/** Where each level starts: slower for beginners, who are still tuning in. */
export const DEFAULT_SPEED: Record<CefrLevel, Speed> = {
  A1: 0.7,
  A2: 0.85,
  B1: 1,
  B2: 1,
};
