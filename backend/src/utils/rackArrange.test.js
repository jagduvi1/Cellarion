/**
 * Backend auto-arrange engine — behavioral twin of the frontend spec
 * (frontend/src/utils/rackArrange.test.js) for the parts this port keeps:
 * comparators + target assignment + change list. The backend engine emits a
 * full `target` assignment (applied atomically in one rack save) instead of
 * the frontend's per-slot op sequence.
 */
const { buildArrangePlan, ARRANGE_STRATEGIES, COMPARATORS } = require('./rackArrange');

const bottle = (id, { name = id, type = 'red', vintage, maturityStatus = null } = {}) => ({
  _id: id,
  vintage,
  maturityStatus,
  wineDefinition: { name, type },
});

const posOf = (target) => new Map(target.map((t) => [t.position, t.bottleId]));

describe('exports', () => {
  test('strategies and comparators stay in sync with the frontend engine', () => {
    expect(ARRANGE_STRATEGIES).toEqual(['maturity', 'type', 'vintage']);
    expect(Object.keys(COMPARATORS)).toEqual(ARRANGE_STRATEGIES);
  });
});

describe('maturity strategy', () => {
  const entries = [
    { position: 1, bottle: bottle('young', { maturityStatus: 'not-ready', vintage: '2023' }) },
    { position: 2, bottle: bottle('fading', { maturityStatus: 'declining', vintage: '2005' }) },
    { position: 5, bottle: bottle('prime', { maturityStatus: 'peak', vintage: '2015' }) },
    { position: 6, bottle: bottle('soon', { maturityStatus: 'late', vintage: '2010' }) },
  ];
  const plan = buildArrangePlan(entries, 6, [], 'maturity');

  test('orders declining → late → peak → not-ready into the first slots', () => {
    const final = posOf(plan.target);
    expect(final.get(1)).toBe('fading');
    expect(final.get(2)).toBe('soon');
    expect(final.get(3)).toBe('prime');
    expect(final.get(4)).toBe('young');
  });

  test('lists every repositioned bottle in changes, sorted by destination', () => {
    expect(plan.changes.map((c) => c.to)).toEqual([1, 2, 3, 4]);
    const fading = plan.changes.find((c) => c.bottle._id === 'fading');
    expect(fading).toMatchObject({ from: 2, to: 1 });
  });

  test('bottles without maturity data sort last', () => {
    const withNone = [
      { position: 1, bottle: bottle('unknown', {}) },
      { position: 2, bottle: bottle('fading', { maturityStatus: 'declining' }) },
    ];
    const final = posOf(buildArrangePlan(withNone, 4, [], 'maturity').target);
    expect(final.get(1)).toBe('fading');
    expect(final.get(2)).toBe('unknown');
  });
});

describe('type strategy', () => {
  test('groups types in red→white→rosé→sparkling order', () => {
    const entries = [
      { position: 1, bottle: bottle('bubbles', { type: 'sparkling' }) },
      { position: 2, bottle: bottle('rose', { type: 'rosé' }) },
      { position: 3, bottle: bottle('barolo', { type: 'red' }) },
      { position: 4, bottle: bottle('chablis', { type: 'white' }) },
    ];
    const final = posOf(buildArrangePlan(entries, 4, [], 'type').target);
    expect([final.get(1), final.get(2), final.get(3), final.get(4)])
      .toEqual(['barolo', 'chablis', 'rose', 'bubbles']);
  });
});

describe('vintage strategy', () => {
  test('sorts oldest first with NV last', () => {
    const entries = [
      { position: 1, bottle: bottle('nv', { vintage: 'NV' }) },
      { position: 2, bottle: bottle('b2020', { vintage: '2020' }) },
      { position: 3, bottle: bottle('b1998', { vintage: '1998' }) },
    ];
    const final = posOf(buildArrangePlan(entries, 3, [], 'vintage').target);
    expect([final.get(1), final.get(2), final.get(3)]).toEqual(['b1998', 'b2020', 'nv']);
  });
});

describe('mechanics', () => {
  test('skips disabled positions when assigning targets', () => {
    const entries = [
      { position: 4, bottle: bottle('a', { maturityStatus: 'peak' }) },
      { position: 5, bottle: bottle('b', { maturityStatus: 'declining' }) },
    ];
    const final = posOf(buildArrangePlan(entries, 6, [1, 2], 'maturity').target);
    expect(final.get(3)).toBe('b'); // first usable slot
    expect(final.get(4)).toBe('a');
    expect(final.has(1)).toBe(false);
    expect(final.has(2)).toBe(false);
  });

  test('already-arranged rack yields an empty change list (target = current)', () => {
    const entries = [
      { position: 1, bottle: bottle('b1', { maturityStatus: 'declining' }) },
      { position: 2, bottle: bottle('b2', { maturityStatus: 'peak' }) },
    ];
    const plan = buildArrangePlan(entries, 4, [], 'maturity');
    expect(plan.changes).toEqual([]);
    expect(posOf(plan.target).get(1)).toBe('b1');
  });

  test('unknown strategy falls back to maturity; ObjectId-like bottle ids stringify', () => {
    const fakeOid = { toString: () => 'f'.repeat(24) };
    const entries = [
      { position: 3, bottle: { _id: fakeOid, maturityStatus: 'declining', wineDefinition: { name: 'X', type: 'red' } } },
    ];
    const plan = buildArrangePlan(entries, 3, [], 'nonsense');
    expect(plan.target).toEqual([{ position: 1, bottleId: 'f'.repeat(24) }]);
  });

  test('ties break alphabetically by wine name (deterministic plans)', () => {
    const entries = [
      { position: 1, bottle: bottle('zin', { name: 'Zinfandel', maturityStatus: 'peak', vintage: '2018' }) },
      { position: 2, bottle: bottle('alb', { name: 'Albariño', maturityStatus: 'peak', vintage: '2018', type: 'red' }) },
    ];
    const final = posOf(buildArrangePlan(entries, 2, [], 'maturity').target);
    expect(final.get(1)).toBe('alb');
    expect(final.get(2)).toBe('zin');
  });
});
