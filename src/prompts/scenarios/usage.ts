/**
 * Which scenario each call opens with. None comes round again until every one
 * for the level has been heard, so the list feels fresh for as long as it can.
 *
 * What's remembered is the ids heard so far in the current round, per level.
 * A scenario only counts as heard once the call is answered: the greeting is
 * prepared as soon as the app is ready, and one that's never answered
 * shouldn't use a scenario up.
 *
 * Scenarios added later haven't been heard, so they come up first. Storage can
 * be unavailable altogether (blocked, or a private window in some browsers),
 * which just means every pick is from the whole list.
 */

import type { CefrLevel } from '../levels';
import { SCENARIOS, type Scenario } from './index';

const STORAGE_KEY = 'scenarios';

type Heard = Partial<Record<CefrLevel, string[]>>;

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string');
}

function load(): Heard {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (!saved || typeof saved !== 'object') return {};
    return Object.fromEntries(
      Object.entries(saved).filter(([, ids]) => isIdList(ids)),
    );
  } catch {
    return {};
  }
}

function save(heard: Heard): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(heard));
  } catch {
    // This call still went ahead; it just won't be remembered.
  }
}

/** A scenario for a new call at `level`, from those not yet heard. */
export function pickScenario(
  level: CefrLevel,
  random: () => number = Math.random,
): Scenario {
  const all = Object.entries(SCENARIOS[level]).map(([id, line]): Scenario => ({
    id,
    line,
  }));
  const heardIds = load()[level] ?? [];
  const heard = new Set(heardIds);
  const unheard = all.filter((scenario) => !heard.has(scenario.id));
  // Every one has been heard only if those that hadn't were since removed —
  // markScenarioUsed starts a new round before it gets there otherwise. Any
  // will do then, except the last one heard, which mustn't come straight back.
  const lastHeard = heardIds.at(-1);
  const others = all.filter((scenario) => scenario.id !== lastHeard);
  const pool = unheard.length > 0 ? unheard : others.length > 0 ? others : all;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * Records that `id` has been heard. Once that's all of them, a new round
 * starts with just this one in it, so it can't come straight back.
 */
export function markScenarioUsed(level: CefrLevel, id: string): void {
  const known = new Set(Object.keys(SCENARIOS[level]));
  const all = load();
  // Ids since removed from the list would otherwise never let a round end.
  const heard = (all[level] ?? []).filter(
    (heardId) => known.has(heardId) && heardId !== id,
  );
  heard.push(id);
  all[level] = heard.length >= known.size ? [id] : heard;
  save(all);
}
