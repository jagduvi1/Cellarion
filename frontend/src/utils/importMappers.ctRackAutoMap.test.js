/**
 * CellarTracker Location/Bin → rack auto-map: end-to-end tests against the
 * REAL fixture bundle (see importMappers.cellartracker.test.js for fixture
 * provenance). Every expectation is written BY HAND from the fixture
 * contents.
 *
 * The bundle's Inventory table has these Location groups:
 *   Wine Fridge      → A1…A6, B1…B3 (letter-number, consistent) → AUTO-MAPS
 *   Cellar           → blanks + R3C2D1/R5C1D2/R6C3D1 + 147/148/149 +
 *                      D-04-x/E-01-x + P1…P6 + C1/C2 (MIXED)      → fallback
 *   Offsite Storage  → 12-3-4, 12-3-5, BIN1, C3, C4 (mixed)       → fallback
 *   EuroCave         → A12 ×4 (one distinct placement)            → fallback
 *   Basement         → "Rack B - Top" ×3 (freeform)               → fallback
 *   Bar              → blank bin                                  → fallback
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeImportBuffer,
  parseAndMap,
  applyCtRackAutoMap,
  getDefaultRackConfig,
  summariseRacks,
} from './importMappers';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cellartracker');
const parseFixture = (...p) =>
  parseAndMap(decodeImportBuffer(fs.readFileSync(path.join(FIXTURES, ...p))).text);

// ---------------------------------------------------------------------------
// Inventory table — per-bottle placement, the canonical source
// ---------------------------------------------------------------------------
describe('CT Inventory: Location/Bin auto-map (bundle)', () => {
  const result = parseFixture('bundle', 'CellarTracker_Inventory.tsv');

  it('auto-maps the consistent Wine Fridge group (A1…A6, B1…B3 → 2×6 grid)', () => {
    const fridge = result.items.filter((i) => i.rackName === 'Wine Fridge');
    expect(fridge).toHaveLength(9);
    const a1 = fridge.find((i) => i.location === 'Wine Fridge / A1');
    expect(a1).toMatchObject({ row: 1, col: 1, rackRows: 2, rackCols: 6 });
    const b3 = fridge.find((i) => i.location === 'Wine Fridge / B3');
    expect(b3).toMatchObject({ row: 2, col: 3 });
    // The freeform location text is kept as well (belt and braces)
    expect(fridge.every((i) => i.location.startsWith('Wine Fridge / '))).toBe(true);
  });

  it('reports the Wine Fridge rack in ctRackAutoMap with pattern + counts + spec', () => {
    expect(result.ctRackAutoMap.racks['Wine Fridge']).toEqual({
      pattern: 'letter-number',
      location: 'Wine Fridge',
      binCount: 9,
      placedCount: 9,
      unparsedCount: 0,
      rows: 2,
      cols: 6,
      spec: { type: 'grid', rows: 2, cols: 6, typeConfig: {} },
    });
  });

  it('falls back for every mixed / ambiguous / freeform group — no rack, no guessing', () => {
    for (const item of result.items) {
      if (item.rackName === 'Wine Fridge') continue;
      expect(item.rackName).toBeUndefined();
      expect(item.row).toBeUndefined();
      expect(item.rackPosition).toBeUndefined();
    }
    const fallbackLocations = result.ctRackAutoMap.textFallback
      .map((f) => f.location)
      .sort();
    expect(fallbackLocations).toEqual(['Bar', 'Basement', 'Cellar', 'EuroCave', 'Offsite Storage']);
  });

  it('keeps the joined location text intact on fallback bottles', () => {
    const locations = new Set(result.items.map((i) => i.location));
    expect(locations).toContain('Cellar / R3C2D1');
    expect(locations).toContain('Basement / Rack B - Top');
    expect(locations).toContain('Offsite Storage / BIN1');
  });

  it('strips the transient _ctLocation/_ctBin markers from every item', () => {
    for (const item of result.items) {
      expect(item).not.toHaveProperty('_ctLocation');
      expect(item).not.toHaveProperty('_ctBin');
    }
  });

  it('feeds the existing preview pipeline unchanged (summariseRacks + default config)', () => {
    const summary = summariseRacks(result.items);
    expect(Object.keys(summary)).toEqual(['Wine Fridge']);
    expect(summary['Wine Fridge'].count).toBe(9);
    const info = {
      ...summary['Wine Fridge'],
      ctRackSpec: result.ctRackAutoMap.racks['Wine Fridge'].spec,
    };
    expect(getDefaultRackConfig('cellartracker', info)).toEqual({
      type: 'grid', rows: 2, cols: 6, typeConfig: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Bottles table — consumed bottles never claim rack slots
// ---------------------------------------------------------------------------
describe('CT Bottles: auto-map skips history bottles', () => {
  const result = parseFixture('bundle', 'CellarTracker_Bottles.tsv');

  it('places the 9 active Wine Fridge bottles but never consumed ones', () => {
    const placed = result.items.filter((i) => i.rackName === 'Wine Fridge');
    expect(placed).toHaveLength(9);
    expect(placed.every((i) => !i.addToHistory)).toBe(true);
    for (const item of result.items.filter((i) => i.addToHistory)) {
      expect(item.rackName).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// List table — multi-location wines export blank Location → nothing to map
// ---------------------------------------------------------------------------
describe('CT List: blank/aggregated locations never place', () => {
  const result = parseFixture('bundle', 'CellarTracker_List.tsv');

  it('gives the multi-location Cristal (blank Location) no rack fields', () => {
    const cristal = result.items.filter((i) => i.producer === 'Louis Roederer');
    expect(cristal).toHaveLength(4);
    for (const bottle of cristal) {
      expect(bottle.rackName).toBeUndefined();
      expect(bottle.location).toBe('');
    }
  });

  it('does not invent racks from the List table (bins mostly blank at wine grain)', () => {
    // In the bundle's List export only 4 wines carry a bin at all, each in a
    // different location — nothing reaches 3 distinct placements.
    expect(result.items.every((i) => i.rackName === undefined)).toBe(true);
    expect(result.ctRackAutoMap.racks).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Consumed / Purchase tables — no placement surface at all
// ---------------------------------------------------------------------------
describe('CT Consumed/Purchase: no auto-map', () => {
  it('never assigns rack fields to Consumed events', () => {
    const result = parseFixture('bundle', 'CellarTracker_Consumed.tsv');
    expect(result.items.every((i) => i.rackName === undefined)).toBe(true);
  });

  it('never assigns rack fields to Purchase lots (table has no Location/Bin)', () => {
    const result = parseFixture('bundle', 'CellarTracker_Purchase.tsv');
    expect(result.items.every((i) => i.rackName === undefined)).toBe(true);
    expect(result.ctRackAutoMap).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyCtRackAutoMap unit behaviours not covered by the fixtures
// ---------------------------------------------------------------------------
describe('applyCtRackAutoMap', () => {
  const mk = (loc, bin, extra = {}) => ({
    wineName: 'W', producer: 'P', _ctLocation: loc, _ctBin: bin, ...extra,
  });

  it('honours binOrder: col-row for "column,row" cellars (support ticket 2026-09-05)', () => {
    const items = [mk('North rack', '2,7'), mk('North rack', '2,8'), mk('North rack', '3,1'), mk('North rack', '1,12')];
    const { racks } = applyCtRackAutoMap(items, { binOrder: 'col-row' });
    expect(items[0]).toMatchObject({ rackName: 'North rack', row: 7, col: 2, rackRows: 12, rackCols: 3 });
    expect(racks['North rack']).toMatchObject({ pattern: 'segments', rows: 12, cols: 3, spec: { type: 'grid', rows: 12, cols: 3, typeConfig: {} } });
  });

  it('parseAndMap threads ctBinOrder through to the auto-map', () => {
    const text = decodeImportBuffer(fs.readFileSync(path.join(FIXTURES, 'bundle', 'CellarTracker_Inventory.tsv'))).text;
    const { items } = parseAndMap(text, undefined, { ctBinOrder: 'col-row' });
    const fridge = items.filter((i) => i.rackName === 'Wine Fridge');
    expect(fridge).toHaveLength(9);
    expect(fridge.find((i) => i.location === 'Wine Fridge / B3')).toMatchObject({ row: 3, col: 2, rackRows: 6, rackCols: 2 });
  });

  it('emits shelf geometry for R<r>C<c>D<d> bins with front/back depth', () => {
    const items = [
      mk('Cave', 'R1C1D1'), mk('Cave', 'R1C1D2'),
      mk('Cave', 'R2C3D1'), mk('Cave', 'R4C2D2'),
    ];
    const { racks } = applyCtRackAutoMap(items);
    expect(items[0]).toMatchObject({
      rackName: 'Cave', rackPosition: 1, layer: 1, slotInLayer: 1,
      rackRows: 4, rackCols: 3, rackType: 'shelf',
    });
    expect(items[1]).toMatchObject({ rackPosition: 1, layer: 2, slotInLayer: 1 });
    expect(racks.Cave.spec).toEqual({
      type: 'shelf', rows: 4, cols: 3,
      typeConfig: { bottlesPerCell: 1, backCols: 3 },
    });
  });

  it('splits 3-segment bins into sub-racks named "<Location> <segment>"', () => {
    const items = [
      mk('Offsite', '12-3-4'), mk('Offsite', '12-3-5'),
      mk('Offsite', '13-1-1'), mk('Offsite', 'illegible'),
    ];
    const { racks, textFallback } = applyCtRackAutoMap(items);
    expect(items[0]).toMatchObject({ rackName: 'Offsite 12', row: 3, col: 4, rackRows: 3, rackCols: 5 });
    expect(items[2]).toMatchObject({ rackName: 'Offsite 13', row: 1, col: 1 });
    expect(items[3].rackName).toBeUndefined();
    expect(racks['Offsite 12'].placedCount).toBe(2);
    expect(racks['Offsite 13'].placedCount).toBe(1);
    // Sub-rack leftovers are reported at location level, not per rack
    expect(textFallback).toEqual([{ location: 'Offsite', count: 1 }]);
  });

  it('reports parse leftovers of a single-rack group on the rack itself', () => {
    const items = [
      mk('Fridge', 'A1'), mk('Fridge', 'A2'), mk('Fridge', 'B1'),
      mk('Fridge', 'B2'), mk('Fridge', 'top somewhere'),
    ];
    const { racks, textFallback } = applyCtRackAutoMap(items);
    expect(racks.Fridge).toMatchObject({ placedCount: 4, unparsedCount: 1, binCount: 5 });
    expect(textFallback).toEqual([]);
    expect(items[4].rackName).toBeUndefined();
  });

  it('emits rackPosition only (no dims) for sequential bins', () => {
    const items = [mk('Cellar', '147'), mk('Cellar', '148'), mk('Cellar', '149')];
    const { racks } = applyCtRackAutoMap(items);
    expect(items[0]).toMatchObject({ rackName: 'Cellar', rackPosition: 147 });
    expect(items[0].rackRows).toBeUndefined();
    expect(items[0].row).toBeUndefined();
    expect(racks.Cellar.spec).toBeUndefined();
    expect(racks.Cellar.pattern).toBe('sequential');
  });

  it('never overrides an item that already carries rack fields', () => {
    const items = [
      mk('Fridge', 'A1', { rackName: 'Explicit', rackPosition: 7 }),
      mk('Fridge', 'A2'), mk('Fridge', 'B1'), mk('Fridge', 'B2'),
    ];
    applyCtRackAutoMap(items);
    expect(items[0]).toMatchObject({ rackName: 'Explicit', rackPosition: 7 });
    expect(items[0].row).toBeUndefined();
  });
});
