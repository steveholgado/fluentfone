import { VOICES } from '#/lib/text-to-speech';
import {
  buildConversationInstruction,
  buildGreetingInstruction,
  type CefrLevel,
} from '#/prompts';

export const LANGUAGE = 'spanish';
export const VOICE_ID = VOICES.es;

export const DEFAULT_LEVEL: CefrLevel = 'A2';

export const GREETING_INSTRUCTION = buildGreetingInstruction(DEFAULT_LEVEL);
export const CONVERSATION_INSTRUCTION =
  buildConversationInstruction(DEFAULT_LEVEL);
