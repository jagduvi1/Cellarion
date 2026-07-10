import { describe, it, expect } from 'vitest';
import { buildArrangePlan, ARRANGE_STRATEGIES } from './rackArrange';

const bottle = (id, { name = id, type = 'red', vintage, maturityStatus = null } = {}) => ({
  _id: id,
  vintage,
  maturityStatus,
  wineDefinition: { name, type },
});

/** Apply the step sequence to the starting placement and return pos→id. */
function applySteps(entries, steps) {
  const state = new Map(entries.map(e => [e.position, e.bottle._id]));
  for (const { from, to } of steps) {
    const moving = state.get(from);
    expect(moving).toBeDefined(); // every step's source must be occupied
    const displaced = state.get(to);
    if (displaced !== undefined) state.set(from, displaced);
    else state.delete(from);
    state.set(to, moving);
  }
  return state;
}

describe('buildArrangePlan — maturity strategy', () => {
  const entries = [
    { position: 1, bottle: bottle('young', { maturityStatus: 'not-ready', vintage: '2023' }) },
    { position: 2, bottle: bottle('fading', { maturityStatus: 'declining', vintage: '2005' }) },
    { position: 5, bottle: bottle('prime', { maturityStatus: 'peak', vintage: '2015' }) },
    { position: 6, bottle: bottle('soon', { maturityStatus: 'late', vintage: '2010' }) },
  ];

  const plan = buildArrangePlan(entries, 6, [], 'maturity');

  it('orders declining → late → peak → not-ready into the first slots', () => {
    const final = applySteps(entries, plan.steps);
    expect(final.get(1)).toBe('fading');
    expect(final.get(2)).toBe('soon');
    expect(final.get(3)).toBe('prime');
    expect(final.get(4)).toBe('young');
  });

  it('lists every repositioned bottle in changes, sorted by destination', () => {
    expect(plan.changes.map(c => c.to)).toEqual([1, 2, 3, 4]);
    const fading = plan.changes.find(c => c.bottle._id === 'fading');
    expect(fading).toMatchObject({ from: 2, to: 1 });
  });

  it('bottles without maturity data sort last', () => {
    const withNone = [
      { position: 1, bottle: bottle('unknown', {}) },
      { position: 2, bottle: bottle('fading', { maturityStatus: 'declining' }) },
    ];
    const p = buildArrangePlan(withNone, 4, [], 'maturity');
    const final = applySteps(withNone, p.steps);
    expect(final.get(1)).toBe('fading');
    expect(final.get(2)).toBe('unknown');
  });
});

describe('buildArrangePlan — type strategy', () => {
  it('groups types in red→white→rosé→sparkling order', () => {
    const entries = [
      { position: 1, bottle: bottle('bubbles', { type: 'sparkling' }) },
      { position: 2, bottle: bottle('rose', { type: 'rosé' }) },
      { position: 3, bottle: bottle('barolo', { type: 'red' }) },
      { position: 4, bottle: bottle('chablis', { type: 'white' }) },
    ];
    const final = applySteps(entries, buildArrangePlan(entries, 4, [], 'type').steps);
    expect([final.get(1), final.get(2), final.get(3), final.get(4)])
      .toEqual(['barolo', 'chablis', 'rose', 'bubbles']);
  });
});

describe('buildArrangePlan — vintage strategy', () => {
  it('sorts oldest first with NV last', () => {
    const entries = [
      { position: 1, bottle: bottle('nv', { vintage: 'NV' }) },
      { position: 2, bottle: bottle('b2020', { vintage: '2020' }) },
      { position: 3, bottle: bottle('b1998', { vintage: '1998' }) },
    ];
    const final = applySteps(entries, buildArrangePlan(entries, 3, [], 'vintage').steps);
    expect([final.get(1), final.get(2), final.get(3)]).toEqual(['b1998', 'b2020', 'nv']);
  });
});

describe('buildArrangePlan — mechanics', () => {
  it('skips disabled positions when assigning targets', () => {
    const entries = [
      { position: 4, bottle: bottle('a', { maturityStatus: 'peak' }) },
      { position: 5, bottle: bottle('b', { maturityStatus: 'declining' }) },
    ];
    const plan = buildArrangePlan(entries, 6, [1, 2], 'maturity');
    const final = applySteps(entries, plan.steps);
    expect(final.get(3)).toBe('b'); // first usable slot
    expect(final.get(4)).toBe('a');
    expect(final.has(1)).toBe(false);
    expect(final.has(2)).toBe(false);
  });

  it('returns an empty plan when the rack is already arranged', () => {
    const entries = [
      { position: 1, bottle: bottle('b1', { maturityStatus: 'declining' }) },
      { position: 2, bottle: bottle('b2', { maturityStatus: 'peak' }) },
    ];
    const plan = buildArrangePlan(entries, 4, [], 'maturity');
    expect(plan.steps).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  it('handles a pure two-cycle with a single swap step', () => {
    const entries = [
      { position: 1, bottle: bottle('late1', { maturityStatus: 'peak' }) },
      { position: 2, bottle: bottle('urgent', { maturityStatus: 'declining' }) },
    ];
    const plan = buildArrangePlan(entries, 2, [], 'maturity');
    expect(plan.steps).toEqual([{ from: 2, to: 1, swap: true }]);
  });

  it('reaches the desired state on a full-rack rotation (3-cycle, no empty slot)', () => {
    // Desired order: c(declining)→1, a(late)→2, b(peak)→3 from a,b,c — a 3-cycle
    const entries = [
      { position: 1, bottle: bottle('a', { maturityStatus: 'late' }) },
      { position: 2, bottle: bottle('b', { maturityStatus: 'peak' }) },
      { position: 3, bottle: bottle('c', { maturityStatus: 'declining' }) },
    ];
    const plan = buildArrangePlan(entries, 3, [], 'maturity');
    const final = applySteps(entries, plan.steps);
    expect([final.get(1), final.get(2), final.get(3)]).toEqual(['c', 'a', 'b']);
    expect(plan.steps.length).toBeLessThanOrEqual(2); // k-1 swaps for a 3-cycle
  });

  it('every strategy produces a valid executable plan on a scrambled rack', () => {
    const entries = [
      { position: 2, bottle: bottle('r1', { type: 'red', vintage: '2010', maturityStatus: 'peak' }) },
      { position: 3, bottle: bottle('w1', { type: 'white', vintage: '2022', maturityStatus: 'early' }) },
      { position: 5, bottle: bottle('r2', { type: 'red', vintage: '1999', maturityStatus: 'declining' }) },
      { position: 8, bottle: bottle('s1', { type: 'sparkling', vintage: 'NV' }) },
    ];
    for (const strategy of ARRANGE_STRATEGIES) {
      const plan = buildArrangePlan(entries, 8, [4], strategy);
      const final = applySteps(entries, plan.steps);
      expect(final.size).toBe(4); // no bottle lost or duplicated
      expect([...final.keys()].every(p => p !== 4)).toBe(true); // disabled never used
      expect([...final.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 5]); // compacted to first usable slots
    }
  });
});
