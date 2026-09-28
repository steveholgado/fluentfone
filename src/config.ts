import { VOICES } from '#/lib/text-to-speech';
import { buildSystemInstruction, type CefrLevel } from '#/prompts';

export const LANGUAGE = 'spanish';
export const VOICE_ID = VOICES.es;

export const DEFAULT_LEVEL: CefrLevel = 'B1';

export const SYSTEM_INSTRUCTION = buildSystemInstruction(DEFAULT_LEVEL);
