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
 * language, for the same reason. What varies — what the friend opens with —
 * goes in the trigger.
 */

import type { LanguageId } from '#/config';
import { LANGUAGE_SPECS, renderLanguageBlock } from './languages';
import { renderLevelBlock, type CefrLevel } from './levels';
import type { Scenario } from './scenarios';

export { LANGUAGE_SPECS, renderLanguageBlock } from './languages';
export { LEVELS, renderLevelBlock, type CefrLevel } from './levels';
export { SCENARIOS, type Scenario } from './scenarios';
export { markScenarioUsed, pickScenario } from './scenarios/usage';

export function buildSystemInstruction(
  level: CefrLevel,
  language: LanguageId,
): string {
  const { name, country } = LANGUAGE_SPECS[language];
  return `You are a friendly, patient native speaker from ${country} chatting on the phone with a friend who is learning ${name}.

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
 * Sent in the student's place for the opening message, with the line this
 * call opens on. Bracketed so it reads as a direction rather than something
 * the student said — in English, it would otherwise fall under the rule for a
 * student answering in English.
 *
 * The language to say it in is named rather than referred to: everything the
 * model has read by then is in English, so "the language of the call" could
 * be taken for English.
 *
 * The hello is kept to a word or two and the line already ends in its
 * question, so the opening is no more than the student can take in on one
 * listen. The line is quoted in the caller's own voice, and who "I" and "you"
 * are is spelled out as well: told about "your sister", the model took her
 * for the friend's and asked them about her.
 *
 * It can differ from call to call because it's not part of the system
 * instruction: the worker doesn't match a conversation on it.
 */
export function greetingTrigger(
  scenario: Scenario,
  language: LanguageId,
): string {
  return `[The conversation is starting. Say hello to your friend in one or two words, then say this in ${LANGUAGE_SPECS[language].name}: "${scenario.line}" In that, "I" and "my" mean you, and "you" means your friend.]`;
}

/**
 * The student's last turn of the call, with a direction to say goodbye after
 * it. Bracketed, like the greeting's trigger, so it reads as a direction
 * rather than something the student said. It overrides the instruction's
 * "ask one question" for this one reply, which would leave the call open.
 *
 * Added to the student's message because a turn sends exactly one, so there
 * is nowhere else for it to go.
 */
export function finalTurnPrompt(text: string): string {
  return `${text}\n\n[This is the end of the call. Reply to what your friend just said in one short sentence, then say goodbye warmly in one short sentence. Do not ask a question.]`;
}
