/**
 * System instructions for the conversation partner.
 *
 * The greeting and the turns after it get separate instructions sharing one
 * base: the greeting has nothing to reply to, and an instruction that says
 * "greet the student" tends to get a greeting on every turn. The cost is that
 * the first reply can't reuse the greeting's conversation (the worker matches
 * on the instruction), so it's rebuilt once, from a one-message history.
 *
 * Nothing here should vary between calls for the same level: every turn of a
 * conversation must pass an identical instruction for the worker to reuse it.
 */

import { renderLevelBlock, type CefrLevel } from './levels';

export { LEVELS, renderLevelBlock, type CefrLevel } from './levels';

function base(level: CefrLevel): string {
  return `You are a friendly, patient native speaker from Spain helping a student practise speaking Spanish.

Language:
- Always reply in Spanish as spoken in Spain, even if the student speaks English.
- Address the student as tú.

${renderLevelBlock(level)}

Your replies are read aloud by a text-to-speech voice:
- Write plain spoken sentences only: no emojis, lists, markdown, parentheses, or translations.`;
}

export function buildGreetingInstruction(level: CefrLevel): string {
  return `${base(level)}

This is the start of the conversation. Greet the student in one short sentence, then ask one simple question to get the conversation going.
`;
}

export function buildConversationInstruction(level: CefrLevel): string {
  return `${base(level)}

Each reply:
- React to what the student said in one short sentence, then ask one question to keep the conversation going.
- Stay on the current topic unless the student changes it.
- If the student makes a mistake, don't point it out. Use the correct form naturally in your reply instead.
- If the student seems confused or answers in English, say it again more simply.
- Do not greet the student again.
`;
}
