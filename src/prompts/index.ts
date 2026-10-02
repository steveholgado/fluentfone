/**
 * What the conversation partner is told.
 *
 * One system instruction serves every call, the greeting included: the worker
 * only carries a conversation on when the instruction matches exactly, so a
 * separate greeting instruction would have the first reply rebuild it. What
 * the greeting needs on top goes in its trigger — sent in the student's place
 * for the opening message, and never part of the history.
 *
 * Nothing in the instruction should vary between calls for the same level and
 * language, for the same reason. What varies — why the friend is calling —
 * goes in the trigger.
 */

import type { LanguageId } from '#/config';
import { LANGUAGE_SPECS, renderLanguageBlock } from './languages';
import { renderLevelBlock, type CefrLevel } from './levels';
import type { Scenario } from './scenarios';

export { LANGUAGE_SPECS, renderLanguageBlock } from './languages';
export { LEVELS, renderLevelBlock, type CefrLevel } from './levels';
export { SCENARIOS, type Scenario } from './scenarios';

export function buildSystemInstruction(
  level: CefrLevel,
  language: LanguageId,
): string {
  return `You are a friendly, patient native speaker from ${LANGUAGE_SPECS[language].country} chatting on the phone with a friend who is learning Spanish.

${renderLanguageBlock(language)}

${renderLevelBlock(level)}

Your replies are read aloud by a text-to-speech voice:
- Write plain spoken sentences only: no emojis, lists, markdown, parentheses, or translations.

Each reply:
- React to what your friend said in one short sentence, then ask one question to keep the conversation going.
- Stay on the current topic unless your friend changes it.
- If your friend makes a mistake, don't point it out. Use the correct form naturally in your reply instead.
- If your friend seems confused or answers in English, say it again more simply.
- Do not greet your friend again.
`;
}

/**
 * Sent in the student's place for the opening message, with the reason for
 * this call. Bracketed so it reads as a direction rather than something the
 * student said — in English, it would otherwise fall under the rule for a
 * student answering in English.
 *
 * The reason is quoted in the caller's own voice, and who "I" and "you" are
 * is spelled out as well: told about "your sister", the model took her for
 * the friend's and asked them about her.
 *
 * It can differ from call to call because it's not part of the system
 * instruction: the worker doesn't match a conversation on it.
 */
export function greetingTrigger(scenario: Scenario): string {
  return `[The conversation is starting. Greet your friend in one short sentence. Then tell your friend, in your own words, why you're calling: "I'm calling because ${scenario.reason}" In that, "I" and "my" mean you, and "you" means your friend. Then ask your friend one question about it.]`;
}
