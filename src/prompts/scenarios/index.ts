/**
 * Why the friend is calling: one is picked for each call and given to the
 * model with the greeting trigger, so every conversation opens on something
 * different.
 *
 * Each level's list maps an id to the reason for the call.
 *
 * Writing one:
 * - The reason is in the caller's own words, completing "I'm calling
 *   because …", in English, and ends with a full stop.
 * - "I" and "my" are the caller; "you" and "your" are the friend, and only
 *   ever the friend. Written the other way round ("your sister" for the
 *   caller's sister), the model got who was who wrong, and "they" for the
 *   friend read as whoever else was in the sentence.
 * - Bring other people in as relatives, colleagues, or neighbours, never as
 *   "a friend": they could be taken for the friend being called.
 * - Keep to what the level allows in ./levels.ts — its grammar, vocabulary,
 *   and question style.
 * - End with what the caller wants from the friend, in the level's question
 *   style: "I want to know …", "I want you to help me choose: X or Y",
 *   "I want your advice …". Needing something isn't enough — told "I need a
 *   name for my cat", the model asked the friend what colour the cat was.
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
  reason: string;
}

export const SCENARIOS: Record<CefrLevel, Record<string, string>> = {
  A1: A1_SCENARIOS,
  A2: A2_SCENARIOS,
  B1: B1_SCENARIOS,
  B2: B2_SCENARIOS,
};
