import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildArrangePlan,
  ARRANGE_STRATEGIES,
  buildFillOrder,
  FILL_CORNERS,
  buildArrangeRecord,
  buildUndoSteps,
  canUndoArrange,
  saveArrangeRecord,
  loadArrangeRecord,
  clearArrangeRecord,
  loadArrangeCorner,
  saveArrangeCorner,
  ARRANGE_RECORD_TTL_MS,
} from './rackArrange';

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

  it('fills according to a custom positionOrder when provided', () => {
    const entries = [
      { position: 1, bottle: bottle('a', { maturityStatus: 'declining' }) },
      { position: 2, bottle: bottle('b', { maturityStatus: 'peak' }) },
    ];
    // Bottom-left first on a 2x2 grid: 3, 4, 1, 2
    const plan = buildArrangePlan(entries, 4, [], 'maturity', [3, 4, 1, 2]);
    const final = applySteps(entries, plan.steps);
    expect(final.get(3)).toBe('a'); // most urgent → first priority slot
    expect(final.get(4)).toBe('b');
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

describe('buildFillOrder', () => {
  // 2x3 grid, row-major: 1 2 3 / 4 5 6
  const grid = { type: 'grid', rows: 2, cols: 3 };

  it('orders a grid from each corner', () => {
    expect(buildFillOrder(grid, 'top-left')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(buildFillOrder(grid, 'top-right')).toEqual([3, 2, 1, 6, 5, 4]);
    expect(buildFillOrder(grid, 'bottom-left')).toEqual([4, 5, 6, 1, 2, 3]);
    expect(buildFillOrder(grid, 'bottom-right')).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('covers every position exactly once for any rack type and corner', () => {
    const racks = [
      grid,
      { type: 'hex', rows: 3, cols: 3 },
      { type: 'triangle', rows: 3, cols: 4 },
      { type: 'stack', rows: 5 },
      { type: 'cube', rows: 2, cols: 2, typeConfig: { moduleRows: 2, moduleCols: 2 } },
      { type: 'x-rack', typeConfig: { bottlesPerSection: 3 } },
      { isModular: true, modules: [
        { type: 'grid', rows: 2, cols: 2, x: 0, y: 0 },
        { type: 'stack', rows: 3, x: 3, y: 0 },
      ] },
    ];
    for (const rack of racks) {
      for (const corner of FILL_CORNERS) {
        const order = buildFillOrder(rack, corner);
        const sorted = [...order].sort((a, b) => a - b);
        expect(sorted).toEqual(Array.from({ length: order.length }, (_, i) => i + 1));
      }
    }
  });

  it('defaults to top-left (ascending positions on a grid)', () => {
    expect(buildFillOrder(grid)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('undo — record building and reversal', () => {
  const entries = [
    { position: 1, bottle: bottle('young', { maturityStatus: 'not-ready' }) },
    { position: 2, bottle: bottle('fading', { maturityStatus: 'declining' }) },
    { position: 5, bottle: bottle('prime', { maturityStatus: 'peak' }) },
  ];
  const plan = buildArrangePlan(entries, 6, [], 'maturity');
  const record = buildArrangeRecord(entries, plan, 'maturity', 1000);

  it('replaying the reversed steps restores the original layout', () => {
    const afterApply = applySteps(entries, plan.steps);
    const asEntries = [...afterApply].map(([position, id]) => ({ position, bottle: bottle(id) }));
    const restored = applySteps(asEntries, buildUndoSteps(record.steps));
    const original = new Map(entries.map(e => [e.position, e.bottle._id]));
    expect(restored).toEqual(original);
  });

  it('stores slim serializable changes (no bottle objects)', () => {
    expect(record.strategy).toBe('maturity');
    expect(record.appliedAt).toBe(1000);
    for (const c of record.changes) {
      expect(typeof c.bottleId).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(c.bottle).toBeUndefined();
    }
  });

  it('canUndoArrange accepts the exact post-apply state', () => {
    const afterApply = applySteps(entries, plan.steps);
    const slots = [...afterApply].map(([position, id]) => ({ position, bottle: { _id: id } }));
    expect(canUndoArrange(record, slots)).toBe(true);
  });

  it('canUndoArrange rejects a rack that changed after the apply', () => {
    const afterApply = applySteps(entries, plan.steps);
    const slots = [...afterApply].map(([position, id]) => ({ position, bottle: { _id: id } }));
    // Bottle removed from a touched position
    expect(canUndoArrange(record, slots.slice(1))).toBe(false);
    // Different bottle in a touched position
    const swapped = slots.map(s => (s.position === record.touched[0].position ? { ...s, bottle: { _id: 'intruder' } } : s));
    expect(canUndoArrange(record, swapped)).toBe(false);
  });

  it('canUndoArrange rejects a missing or empty record', () => {
    expect(canUndoArrange(null, [])).toBe(false);
    expect(canUndoArrange({ touched: [] }, [])).toBe(false);
  });
});

describe('arrange persistence (localStorage)', () => {
  // Node ≥22 ships a global localStorage stub that shadows jsdom's working
  // one under vitest — replace it with a functional in-memory store.
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });

  beforeEach(() => store.clear());

  it('round-trips a record', () => {
    saveArrangeRecord('r1', { appliedAt: 5000, steps: [], changes: [], touched: [] });
    expect(loadArrangeRecord('r1', 5000 + 1000)).toMatchObject({ appliedAt: 5000 });
  });

  it('is scoped per rack', () => {
    saveArrangeRecord('r1', { appliedAt: 5000, steps: [], changes: [], touched: [] });
    expect(loadArrangeRecord('r2', 6000)).toBeNull();
  });

  it('expires after the TTL and cleans up the stored entry', () => {
    saveArrangeRecord('r1', { appliedAt: 5000, steps: [], changes: [], touched: [] });
    expect(loadArrangeRecord('r1', 5000 + ARRANGE_RECORD_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem('cellarion:arrange:last:r1')).toBeNull();
  });

  it('clearArrangeRecord removes the record', () => {
    saveArrangeRecord('r1', { appliedAt: 5000, steps: [], changes: [], touched: [] });
    clearArrangeRecord('r1');
    expect(loadArrangeRecord('r1', 6000)).toBeNull();
  });

  it('survives corrupt stored JSON', () => {
    localStorage.setItem('cellarion:arrange:last:r1', '{not json');
    expect(loadArrangeRecord('r1', 1000)).toBeNull();
  });

  it('remembers the fill corner per rack, defaulting to top-left', () => {
    expect(loadArrangeCorner('r1')).toBe('top-left');
    saveArrangeCorner('r1', 'bottom-right');
    expect(loadArrangeCorner('r1')).toBe('bottom-right');
    expect(loadArrangeCorner('r2')).toBe('top-left');
    localStorage.setItem('cellarion:arrange:corner:r1', 'nonsense');
    expect(loadArrangeCorner('r1')).toBe('top-left');
  });
});
