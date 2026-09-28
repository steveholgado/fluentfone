/**
 * What the conversation partner is told.
 *
 * One system instruction serves every call, the greeting included: the worker
 * only carries a conversation on when the instruction matches exactly, so a
 * separate greeting instruction would have the first reply rebuild it. What
 * the greeting needs on top goes in its trigger — sent in the student's place
 * for the opening message, and never part of the history.
 *
 * Nothing here should vary between calls for the same level, for the same
 * reason.
 */

import { renderLevelBlock, type CefrLevel } from './levels';

export { LEVELS, renderLevelBlock, type CefrLevel } from './levels';

export function buildSystemInstruction(level: CefrLevel): string {
  return `You are a friendly, patient native speaker from Spain helping a student practise speaking Spanish.

Language:
- Always reply in Spanish as spoken in Spain, even if the student speaks English.
- Address the student as tú.

${renderLevelBlock(level)}

Your replies are read aloud by a text-to-speech voice:
- Write plain spoken sentences only: no emojis, lists, markdown, parentheses, or translations.

Each reply:
- React to what the student said in one short sentence, then ask one question to keep the conversation going.
- Stay on the current topic unless the student changes it.
- If the student makes a mistake, don't point it out. Use the correct form naturally in your reply instead.
- If the student seems confused or answers in English, say it again more simply.
- Do not greet the student again.
`;
}

/**
 * Sent in the student's place for the opening message. Bracketed so it reads
 * as a direction rather than something the student said — in English, it
 * would otherwise fall under the rule for a student answering in English.
 */
export const GREETING_TRIGGER =
  '[The conversation is starting. Greet the student in one short sentence, then ask one simple question to get the conversation going.]';
