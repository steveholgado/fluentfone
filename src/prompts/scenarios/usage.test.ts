import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCENARIOS } from './index';
import { markScenarioUsed, pickScenario } from './usage';

const STORAGE_KEY = 'scenarios';
const A1_IDS = Object.keys(SCENARIOS.A1);
const [A2_ID] = Object.keys(SCENARIOS.A2);
const [B1_ID] = Object.keys(SCENARIOS.B1);

function stored() {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
}

/** Always takes the first of whatever's left. */
const first = () => 0;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pickScenario', () => {
  it('picks from the level it was given', () => {
    const { id, reason } = pickScenario('B2');

    expect(SCENARIOS.B2[id]).toBe(reason);
  });

  it('only picks scenarios not yet heard', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ A1: A1_IDS.slice(0, -1) }),
    );

    expect(pickScenario('A1', first).id).toBe(A1_IDS.at(-1));
  });

  it('keeps each level separate', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ A2: [A2_ID] }));

    expect(pickScenario('A1', first).id).toBe(A1_IDS[0]);
  });

  it('picks from all of them when every one has been heard', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ A1: A1_IDS }));

    expect(pickScenario('A1', first).id).toBe(A1_IDS[0]);
  });

  // As when the scenarios not yet heard have been removed from the list.
  it('never picks the last one heard when every one has been heard', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ A1: ['a1-removed', ...A1_IDS] }),
    );

    expect(pickScenario('A1', () => 0.9999).id).not.toBe(A1_IDS.at(-1));
  });

  it.each([
    ['not JSON', '{'],
    ['not an object', '"A1"'],
    ['not a list of ids', JSON.stringify({ A1: [1, 2] })],
  ])('ignores storage that is %s', (_, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);

    expect(pickScenario('A1', first).id).toBe(A1_IDS[0]);
  });

  it('still picks when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(pickScenario('A1', first).id).toBe(A1_IDS[0]);
  });
});

describe('markScenarioUsed', () => {
  it('remembers what was heard, per level', () => {
    markScenarioUsed('A1', A1_IDS[0]);
    markScenarioUsed('B1', B1_ID);

    expect(stored()).toEqual({ A1: [A1_IDS[0]], B1: [B1_ID] });
  });

  it('records a scenario only once', () => {
    markScenarioUsed('A1', A1_IDS[0]);
    markScenarioUsed('A1', A1_IDS[0]);

    expect(stored()).toEqual({ A1: [A1_IDS[0]] });
  });

  it('drops ids no longer in the list', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ A1: ['a1-removed'] }));

    markScenarioUsed('A1', A1_IDS[0]);

    expect(stored()).toEqual({ A1: [A1_IDS[0]] });
  });

  it('starts a new round once every one has been heard, without the last coming straight back', () => {
    for (const id of A1_IDS) markScenarioUsed('A1', id);

    expect(stored()).toEqual({ A1: [A1_IDS.at(-1)] });
    expect(pickScenario('A1', () => 0.9999).id).not.toBe(A1_IDS.at(-1));
  });

  it('goes through every scenario once before any repeats', () => {
    const heard = A1_IDS.map(() => {
      const { id } = pickScenario('A1');
      markScenarioUsed('A1', id);
      return id;
    });

    expect(new Set(heard).size).toBe(A1_IDS.length);
  });

  it('carries on when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => markScenarioUsed('A1', A1_IDS[0])).not.toThrow();
  });
});
