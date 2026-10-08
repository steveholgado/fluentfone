/**
 * What the friend opens the call with: one is picked for each call and given
 * to the model with the greeting trigger, so every conversation opens on
 * something different.
 *
 * Each level's list maps an id to the opening line.
 *
 * Writing one:
 * - The line is what the caller says straight after hello, in their own
 *   voice, in English — the model says it in the language being learned, so
 *   one list serves every language. Any context comes first, then one
 *   question, and it ends with that question.
 * - Don't say why the friend is calling. Given "I'm calling because …", the
 *   model opened nearly every call with "te llamo porque".
 * - The question carries what the caller wants, in the level's question
 *   style. Put the context in front only when the question needs it: "Luna or
 *   Coco?" means nothing without the new cat. At A1, keep to one short
 *   sentence of it at most.
 * - "I" and "my" are the caller; "you" and "your" are the friend, and only
 *   ever the friend. Written the other way round ("your sister" for the
 *   caller's sister), the model got who was who wrong, and "they" for the
 *   friend read as whoever else was in the sentence.
 * - Bring other people in as relatives, colleagues, or neighbours, never as
 *   "a friend": they could be taken for the friend being called.
 * - Keep to what the level allows in ./levels.ts — its grammar, vocabulary,
 *   sentence length, and question style. That goes for the English too, since
 *   the model follows it closely: at A1, "watch with me", not "watch it with
 *   me", which would bring in a direct object pronoun, and no "I'm cooking"
 *   or "I'm listening", which come out as estar + gerund.
 * - Only time words that are true whatever the day: tomorrow, tonight, last
 *   night, the other day, next week, at the weekend. "It's Friday" is wrong
 *   six days in seven, and "on Sunday" said on a Sunday sounds like today.
 *   Leaving the day open also gives the model something to ask about.
 * - Nothing specific to one country: the same list serves Spain and Mexico.
 * - Don't have the caller describe themselves with an adjective (cansado,
 *   cansada): the partner's gender isn't set, so it could clash with the voice.
 * - It should be something a friend would plausibly ring about.
 *
 * The id is what usage tracking stores, so once one has shipped it is never
 * renamed or reused.
 */

import type { CefrLevel } from '../levels';
import { A1_SCENARIOS } from './a1';
import { A2_SCENARIOS } from './a2';
import { B1_SCENARIOS } from './b1';
import { B2_SCENARIOS } from './b2';

/** One scenario, as it's picked for a call. */
export interface Scenario {
  id: string;
  line: string;
}

export const SCENARIOS: Record<CefrLevel, Record<string, string>> = {
  A1: A1_SCENARIOS,
  A2: A2_SCENARIOS,
  B1: B1_SCENARIOS,
  B2: B2_SCENARIOS,
};
