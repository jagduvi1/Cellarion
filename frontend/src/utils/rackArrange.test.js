import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildFillOrder,
  FILL_CORNERS,
  buildArrangeRecord,
  canUndoArrange,
  saveArrangeRecord,
  loadArrangeRecord,
  clearArrangeRecord,
  loadArrangeCorner,
  saveArrangeCorner,
  ARRANGE_RECORD_TTL_MS,
} from './rackArrange';

/* The arrange DECISION ENGINE moved to the server (one engine for the web
 * modal and the MCP auto_arrange tool) — its behavioral spec lives in
 * backend/src/utils/rackArrange.test.js. This file covers what stays
 * client-side: fill-corner geometry and the applied-plan record. */

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

describe('arrange record (server-plan shape) + undo predicate', () => {
  // A server preview payload: two bottles swap places.
  const preview = {
    strategy: 'maturity',
    before: [{ position: 1, bottleId: 'young' }, { position: 2, bottleId: 'fading' }],
    target: [{ position: 1, bottleId: 'fading' }, { position: 2, bottleId: 'young' }],
    changes: [
      { from: 2, to: 1, bottleId: 'fading', name: 'Fading Barolo', vintage: '2005' },
      { from: 1, to: 2, bottleId: 'young', name: 'Young Chianti', vintage: '2023' },
    ],
  };
  const record = buildArrangeRecord(preview, 1000);

  it('stores slim serializable before/after/changes', () => {
    expect(record).toMatchObject({ strategy: 'maturity', appliedAt: 1000 });
    expect(record.before).toEqual(preview.before);
    expect(record.after).toEqual(preview.target);
    for (const c of record.changes) {
      expect(typeof c.bottleId).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(c.bottle).toBeUndefined();
    }
  });

  it('canUndoArrange accepts exactly the applied layout', () => {
    const slots = [
      { position: 1, bottle: { _id: 'fading' } },
      { position: 2, bottle: { _id: 'young' } },
    ];
    expect(canUndoArrange(record, slots)).toBe(true);
  });

  it('canUndoArrange rejects any drift from the applied layout', () => {
    // A bottle removed since
    expect(canUndoArrange(record, [{ position: 1, bottle: { _id: 'fading' } }])).toBe(false);
    // A different bottle in a slot
    expect(canUndoArrange(record, [
      { position: 1, bottle: { _id: 'intruder' } },
      { position: 2, bottle: { _id: 'young' } },
    ])).toBe(false);
    // A NEW bottle placed in a previously-empty slot also blocks undo — the
    // server restores the FULL before-assignment and would refuse anyway.
    expect(canUndoArrange(record, [
      { position: 1, bottle: { _id: 'fading' } },
      { position: 2, bottle: { _id: 'young' } },
      { position: 3, bottle: { _id: 'newcomer' } },
    ])).toBe(false);
  });

  it('canUndoArrange rejects a missing or shapeless record', () => {
    expect(canUndoArrange(null, [])).toBe(false);
    expect(canUndoArrange({ before: [], after: [] }, [])).toBe(false);
    expect(canUndoArrange({ changes: [] }, [])).toBe(false);
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

  const v2 = { appliedAt: 5000, before: [{ position: 1, bottleId: 'a' }], after: [{ position: 2, bottleId: 'a' }], changes: [] };

  it('round-trips a record', () => {
    saveArrangeRecord('r1', v2);
    expect(loadArrangeRecord('r1', 5000 + 1000)).toMatchObject({ appliedAt: 5000 });
  });

  it('is scoped per rack', () => {
    saveArrangeRecord('r1', v2);
    expect(loadArrangeRecord('r2', 6000)).toBeNull();
  });

  it('expires after the TTL and cleans up the stored entry', () => {
    saveArrangeRecord('r1', v2);
    expect(loadArrangeRecord('r1', 5000 + ARRANGE_RECORD_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem('cellarion:arrange:last:r1')).toBeNull();
  });

  it('drops pre-server-engine (steps-based) records instead of misbehaving', () => {
    saveArrangeRecord('r1', { appliedAt: 5000, steps: [{ from: 1, to: 2 }], changes: [], touched: [] });
    expect(loadArrangeRecord('r1', 6000)).toBeNull();
    expect(localStorage.getItem('cellarion:arrange:last:r1')).toBeNull();
  });

  it('clearArrangeRecord removes the record', () => {
    saveArrangeRecord('r1', v2);
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
