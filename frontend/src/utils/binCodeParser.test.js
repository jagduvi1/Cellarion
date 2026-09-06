/**
 * CellarTracker bin-code parser — hand-written expectations per pattern
 * family, using the exact example formats from the CT export spec (§4.6):
 * `R3C2D1`, `A12`, `12-3-4`, `147`, `Rack B - Top`, `BIN1`, `D-04-1`, blank.
 * The fixtures' real Location/Bin values are exercised end-to-end in
 * importMappers.ctRackAutoMap.test.js.
 */
import { analyzeBinGroup, analyzeBinGroups } from './binCodeParser';

const placementFor = (result, index) => result.placements.find((p) => p.index === index);

// ---------------------------------------------------------------------------
// rowcol — R<r>C<c>
// ---------------------------------------------------------------------------
describe('rowcol family (R3C2)', () => {
  it('parses RxCy codes into row/col and infers dims from the max', () => {
    const r = analyzeBinGroup(['R1C1', 'R1C2', 'R2C1', 'R3C4', 'R5C6']);
    expect(r.pattern).toBe('rowcol');
    expect(r.qualifies).toBe(true);
    expect(r.confidence).toBe(1);
    expect(r.inferredRows).toBe(5);
    expect(r.inferredCols).toBe(6);
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 1, col: 1 });
    expect(placementFor(r, 3)).toEqual({ index: 3, row: 3, col: 4 });
    expect(r.unparsed).toEqual([]);
  });

  it('is case-insensitive and tolerates internal spaces', () => {
    const r = analyzeBinGroup(['r1c1', 'R 2 C 3', 'r3C2']);
    expect(r.pattern).toBe('rowcol');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 1)).toEqual({ index: 1, row: 2, col: 3 });
  });

  it('treats a CONSTANT depth suffix as carrying no information (plain grid)', () => {
    const r = analyzeBinGroup(['R1C1D1', 'R2C3D1', 'R4C2D1']);
    expect(r.pattern).toBe('rowcol');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 1)).toEqual({ index: 1, row: 2, col: 3 });
    expect(r.inferredRows).toBe(4);
    expect(r.inferredCols).toBe(3);
    expect(r.inferredBackCols).toBeUndefined();
  });

  it('drops codes whose row or col exceeds the 20-slot schema clamp', () => {
    const r = analyzeBinGroup(['R1C1', 'R2C2', 'R3C3', 'R25C1', 'R1C21']);
    expect(r.placements.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.unparsed).toEqual([3, 4]);
    expect(r.inferredRows).toBe(3);
    expect(r.inferredCols).toBe(3);
    // 3/5 = 60% parsed, 3 distinct → still qualifies (boundary case)
    expect(r.qualifies).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rowcol-depth — R<r>C<c>D<d> (spec example: R3C2D1)
// ---------------------------------------------------------------------------
describe('rowcol-depth family (R3C2D1)', () => {
  it('maps varying D∈{1,2} onto shelf geometry (rackPosition/layer/slotInLayer)', () => {
    const r = analyzeBinGroup(['R3C2D1', 'R3C2D2', 'R5C1D2', 'R6C3D1']);
    expect(r.pattern).toBe('rowcol-depth');
    expect(r.qualifies).toBe(true);
    expect(r.inferredRows).toBe(6);
    expect(r.inferredCols).toBe(3);
    expect(r.inferredBackCols).toBe(3);
    expect(placementFor(r, 0)).toEqual({ index: 0, rackPosition: 3, layer: 1, slotInLayer: 2 });
    expect(placementFor(r, 1)).toEqual({ index: 1, rackPosition: 3, layer: 2, slotInLayer: 2 });
    expect(placementFor(r, 2)).toEqual({ index: 2, rackPosition: 5, layer: 2, slotInLayer: 1 });
  });

  it('treats a mix of depth-less and D1/D2 codes as front-layer defaults', () => {
    const r = analyzeBinGroup(['R1C1', 'R1C1D2', 'R2C2D1', 'R2C2D2']);
    expect(r.pattern).toBe('rowcol-depth');
    expect(placementFor(r, 0)).toEqual({ index: 0, rackPosition: 1, layer: 1, slotInLayer: 1 });
  });

  it('folds depths beyond 2 into extra grid columns (col = (D-1)×maxC + C)', () => {
    const r = analyzeBinGroup(['R1C1D1', 'R1C2D2', 'R2C1D3', 'R2C2D1']);
    expect(r.pattern).toBe('rowcol-depth');
    expect(r.inferredBackCols).toBeUndefined();
    // maxC = 2 → D1 offset 0, D2 offset 2, D3 offset 4
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 1, col: 1 });
    expect(placementFor(r, 1)).toEqual({ index: 1, row: 1, col: 4 });
    expect(placementFor(r, 2)).toEqual({ index: 2, row: 2, col: 5 });
    expect(r.inferredCols).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// letter-number — A12, B3
// ---------------------------------------------------------------------------
describe('letter-number family (A12)', () => {
  it('maps letters to rows (A=1) and numbers to columns when letters vary', () => {
    const r = analyzeBinGroup(['A1', 'A2', 'A3', 'B1', 'B2', 'C6']);
    expect(r.pattern).toBe('letter-number');
    expect(r.qualifies).toBe(true);
    expect(r.inferredRows).toBe(3);
    expect(r.inferredCols).toBe(6);
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 1, col: 1 });
    expect(placementFor(r, 5)).toEqual({ index: 5, row: 3, col: 6 });
  });

  it('is case-insensitive (a12 = A12)', () => {
    const r = analyzeBinGroup(['a1', 'b2', 'c3']);
    expect(r.pattern).toBe('letter-number');
    expect(placementFor(r, 2)).toEqual({ index: 2, row: 3, col: 3 });
  });

  it('reclassifies a CONSTANT single letter as sequential (P1…P6 = slots 1…6)', () => {
    const r = analyzeBinGroup(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    expect(r.pattern).toBe('sequential');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 0)).toEqual({ index: 0, rackPosition: 1 });
    expect(placementFor(r, 5)).toEqual({ index: 5, rackPosition: 6 });
  });
});

// ---------------------------------------------------------------------------
// segments — 12-3-4, D-04-1, 3.2
// ---------------------------------------------------------------------------
describe('segments family (12-3-4 / D-04-1 / 3.2)', () => {
  it('parses 2-segment codes as row-col (dash and dot separators)', () => {
    const r = analyzeBinGroup(['1-1', '1-2', '2-1', '3.2']);
    expect(r.pattern).toBe('segments');
    expect(r.qualifies).toBe(true);
    expect(r.inferredRows).toBe(3);
    expect(r.inferredCols).toBe(2);
    expect(placementFor(r, 3)).toEqual({ index: 3, row: 3, col: 2 });
    expect(r.subRacks).toBeUndefined();
  });

  // Support ticket 2026-09-02: a 1,354-bottle CellarTracker cellar typed every
  // bin as "row,column" ("5,8"). The comma was not a separator, so 1,174 bins
  // fell through to the freeform-text fallback and no rack was auto-mapped.
  it('parses comma-separated row,col bins (5,8) exactly like dashes and dots', () => {
    const r = analyzeBinGroup(['5,8', '5,9', '6,1', '1,12', '2,3']);
    expect(r.pattern).toBe('segments');
    expect(r.qualifies).toBe(true);
    expect(r.inferredRows).toBe(6);
    expect(r.inferredCols).toBe(12);
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 5, col: 8 });
    expect(placementFor(r, 3)).toEqual({ index: 3, row: 1, col: 12 });
    expect(r.unparsed).toEqual([]);
  });

  it('a thousands-style "1,000" is not a placement (column 0 is invalid)', () => {
    const r = analyzeBinGroup(['1,000', '1,000', '1,000', '2,5']);
    expect(placementFor(r, 0)).toBeUndefined();
  });

  it('parses 3-segment codes as subrack-row-col, splitting the group into sub-racks', () => {
    const r = analyzeBinGroup(['12-3-4', '12-3-5', '12-1-1', '13-2-2']);
    expect(r.pattern).toBe('segments');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 0)).toEqual({ index: 0, subRack: '12', row: 3, col: 4 });
    expect(placementFor(r, 3)).toEqual({ index: 3, subRack: '13', row: 2, col: 2 });
    expect(r.subRacks).toEqual({
      12: { rows: 3, cols: 5 },
      13: { rows: 2, cols: 2 },
    });
  });

  it('handles alpha sub-rack segments and leading zeros (D-04-1)', () => {
    const r = analyzeBinGroup(['D-04-1', 'D-04-2', 'E-01-1', 'E-01-2']);
    expect(r.pattern).toBe('segments');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 0)).toEqual({ index: 0, subRack: 'D', row: 4, col: 1 });
    expect(placementFor(r, 2)).toEqual({ index: 2, subRack: 'E', row: 1, col: 1 });
    expect(r.subRacks.D).toEqual({ rows: 4, cols: 2 });
    expect(r.subRacks.E).toEqual({ rows: 1, cols: 2 });
  });
});

// Support ticket 2026-09-05: the same 1,354-bottle cellar turned out to type
// its bins as "column,row" — the importer had read every "2,7" as row 2,
// column 7. The order is the user's to declare; the codes cannot tell.
describe('binOrder option (column,row cellars)', () => {
  it('col-row swaps the two numeric segments, sub-rack codes included', () => {
    const r = analyzeBinGroup(['2,7', '2,8', '3,1', '1,12'], { binOrder: 'col-row' });
    expect(r.pattern).toBe('segments');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 7, col: 2 });
    expect(placementFor(r, 3)).toEqual({ index: 3, row: 12, col: 1 });
    expect(r.inferredRows).toBe(12);
    expect(r.inferredCols).toBe(3);
    const s = analyzeBinGroup(['12-3-4', '12-3-5', '13-1-1'], { binOrder: 'col-row' });
    expect(placementFor(s, 0)).toEqual({ index: 0, subRack: '12', row: 4, col: 3 });
  });

  it('col-row reads a letter+number code as column letter, row number', () => {
    const r = analyzeBinGroup(['A1', 'A2', 'B1', 'B3'], { binOrder: 'col-row' });
    expect(r.pattern).toBe('letter-number');
    expect(placementFor(r, 3)).toEqual({ index: 3, row: 3, col: 2 });
    expect(r.inferredRows).toBe(3);
    expect(r.inferredCols).toBe(2);
  });

  it('never touches codes that name their axes (R3C2) or sequential bins', () => {
    const rc = analyzeBinGroup(['R3C2', 'R1C1', 'R2C4'], { binOrder: 'col-row' });
    expect(placementFor(rc, 0)).toEqual({ index: 0, row: 3, col: 2 });
    const seq = analyzeBinGroup(['147', '148', '149'], { binOrder: 'col-row' });
    expect(placementFor(seq, 0)).toEqual({ index: 0, rackPosition: 147 });
  });

  it('row-col (the default) is unchanged', () => {
    const r = analyzeBinGroup(['2,7', '2,8', '3,1'], { binOrder: 'row-col' });
    expect(placementFor(r, 0)).toEqual({ index: 0, row: 2, col: 7 });
  });
});

// ---------------------------------------------------------------------------
// sequential — 147, BIN1
// ---------------------------------------------------------------------------
describe('sequential family (147 / BIN1)', () => {
  it('maps bare integers straight to rackPosition', () => {
    const r = analyzeBinGroup(['147', '148', '149']);
    expect(r.pattern).toBe('sequential');
    expect(r.qualifies).toBe(true);
    expect(r.placements).toEqual([
      { index: 0, rackPosition: 147 },
      { index: 1, rackPosition: 148 },
      { index: 2, rackPosition: 149 },
    ]);
    // Dimensions are inferred downstream from maxPosition, not here
    expect(r.inferredRows).toBeUndefined();
    expect(r.inferredCols).toBeUndefined();
  });

  it('strips a constant alpha prefix (BIN1 → 1)', () => {
    const r = analyzeBinGroup(['BIN1', 'BIN2', 'BIN3', 'BIN12']);
    expect(r.pattern).toBe('sequential');
    expect(r.qualifies).toBe(true);
    expect(placementFor(r, 3)).toEqual({ index: 3, rackPosition: 12 });
  });

  it('refuses to treat VARYING prefixes as sequential', () => {
    const r = analyzeBinGroup(['BIN1', 'BOX2', 'CRATE3']);
    expect(r.qualifies).toBe(false);
  });

  it('drops positions beyond a full 20×20 grid (400)', () => {
    const r = analyzeBinGroup(['1', '2', '3', '401']);
    expect(r.pattern).toBe('sequential');
    expect(r.placements.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(r.unparsed).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// Freeform / ambiguity — fall back, never guess
// ---------------------------------------------------------------------------
describe('freeform fallback', () => {
  it('does not qualify freeform text like "Rack B - Top"', () => {
    const r = analyzeBinGroup(['Rack B - Top', 'Rack B - Top', 'Rack B - Middle', 'Top shelf']);
    expect(r.qualifies).toBe(false);
    expect(r.placements).toEqual([]);
    expect(r.unparsed).toEqual([0, 1, 2, 3]);
  });

  it('falls back on a MIXED group even when each code is individually parseable', () => {
    // The spec bundle's "Cellar" group: RCD + bare ints + P-codes + C-codes +
    // 3-segment codes + blanks — no single family reaches 60%.
    const r = analyzeBinGroup([
      '', '', '', '', '', '',
      'R3C2D1', 'R5C1D2', 'R6C3D1',
      '147', '148', '149',
      'D-04-1', 'D-04-2', 'E-01-1', 'E-01-2',
      'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
      'C1', 'C2',
    ]);
    expect(r.qualifies).toBe(false);
  });

  it('fails the >= 60% rule when too few bins parse (2 of 5)', () => {
    const r = analyzeBinGroup(['A1', 'B2', 'no idea', 'top of pile', '']);
    expect(r.pattern).toBe('letter-number');
    expect(r.confidence).toBe(0.4);
    expect(r.qualifies).toBe(false);
  });

  it('passes at exactly 60% with 3 distinct placements', () => {
    const r = analyzeBinGroup(['A1', 'B2', 'C3', 'no idea', '']);
    expect(r.confidence).toBe(0.6);
    expect(r.qualifies).toBe(true);
  });

  it('fails the >= 3 distinct rule when every bottle shares one bin (A12 ×4)', () => {
    const r = analyzeBinGroup(['A12', 'A12', 'A12', 'A12']);
    expect(r.distinctCount).toBe(1);
    expect(r.qualifies).toBe(false);
  });

  it('counts blank bins against the group (mostly-unbinned location stays text)', () => {
    const r = analyzeBinGroup(['A1', 'B2', 'C3', '', '', '', '', '']);
    expect(r.confidence).toBeCloseTo(3 / 8);
    expect(r.qualifies).toBe(false);
  });

  it('returns no placements for an all-blank group', () => {
    const r = analyzeBinGroup(['', '', '']);
    expect(r.pattern).toBeNull();
    expect(r.placements).toEqual([]);
    expect(r.unparsed).toEqual([0, 1, 2]);
    expect(r.qualifies).toBe(false);
  });

  it('handles an empty group', () => {
    const r = analyzeBinGroup([]);
    expect(r.qualifies).toBe(false);
    expect(r.binCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeBinGroups — per-Location grouping with global indexes
// ---------------------------------------------------------------------------
describe('analyzeBinGroups', () => {
  it('groups by Location and reports placements with GLOBAL pair indexes', () => {
    const pairs = [
      { location: 'Wine Fridge', bin: 'A1' },
      { location: 'Cellar', bin: 'weird' },
      { location: 'Wine Fridge', bin: 'A2' },
      { location: 'Wine Fridge', bin: 'B1' },
      { location: 'Cellar', bin: '' },
    ];
    const groups = analyzeBinGroups(pairs);
    expect(Object.keys(groups).sort()).toEqual(['Cellar', 'Wine Fridge']);
    const fridge = groups['Wine Fridge'];
    expect(fridge.qualifies).toBe(true);
    expect(fridge.placements).toEqual([
      { index: 0, row: 1, col: 1 },
      { index: 2, row: 1, col: 2 },
      { index: 3, row: 2, col: 1 },
    ]);
    expect(groups.Cellar.qualifies).toBe(false);
    expect(groups.Cellar.unparsed).toEqual([1, 4]);
  });

  it('skips pairs with a blank Location entirely (multi-location List blanks)', () => {
    const groups = analyzeBinGroups([
      { location: '', bin: 'A1' },
      { location: '  ', bin: 'A2' },
      { location: '', bin: '' },
    ]);
    expect(groups).toEqual({});
  });

  it('handles the spec §4.6 example set end-to-end', () => {
    // One location per spec example — each too small alone; the point is that
    // no example crashes and unparsable ones stay unplaced.
    const groups = analyzeBinGroups([
      { location: 'A', bin: 'R3C2D1' },
      { location: 'A', bin: 'R3C1D1' },
      { location: 'A', bin: 'R1C2D1' },
      { location: 'B', bin: 'Rack B - Top' },
    ]);
    expect(groups.A.qualifies).toBe(true);
    expect(groups.A.pattern).toBe('rowcol'); // D constant → plain grid
    expect(groups.B.qualifies).toBe(false);
  });
});
