/**
 * Starting shapes for the `cabinet` rack type (wine fridges / climate
 * cabinets), grouped by maker and range.
 *
 * They are STARTING SHAPES, never the truth. Makers ship a cabinet with
 * sliding shelves and tell owners to pull shelves out and stack bottles to
 * reach the advertised capacity, so two owners of the same model end up with
 * different layouts — an imported Oeno file showed a "148" running 6 shelves
 * with up to 10 stacked rows. The create form says so and the user edits the
 * rows afterwards.
 *
 * WHAT IS PUBLISHED AND WHAT IS INFERRED: each model's bottle capacity (in
 * 0.75 l Bordeaux bottles) and, where the maker states it, its shelf count
 * come from the maker's own specifications. The width (`cols`) and the split
 * of rows across shelves are INFERRED so that cols × Σ shelfRows lands on the
 * advertised capacity, or within a bottle or two of it where no uniform grid
 * can hit it exactly (a real cabinet's bays are not uniform). `capacity` on
 * each entry is the maker's figure, shown next to the computed total so the
 * user can see the difference before they adjust.
 *
 * Shape: { key, group, shelves, cols, shelfRows, twoDeep, alternate,
 * shelfCols, shelfAlternate, capacity } — see the cabinet contract in
 * rackLayouts.cabinetLayout for what each field means. `alternate` marks the
 * honeycomb shelf whose rows alternate cols / cols−1 (6 in front of 5, then 5
 * in front of 6); it changes capacity, so a preset carrying it is one whose
 * maker stacks that way. `shelfCols` / `shelfAlternate` give a shelf its own
 * width and pattern where the maker's layout is not uniform. Whatever the
 * preset says, the owner then edits every shelf — rows, width, pattern —
 * exactly as for a custom shape.
 */

import { getTotalSlots } from './rackLayouts';

export const CABINET_PRESET_GROUPS = ['vintec', 'liebherrGrandCru', 'liebherrVinidor', 'liebherrVinothek', 'generic'];

export const CABINET_PRESETS = [
  // ── Vintec ───────────────────────────────────────────────────────────────
  { key: 'vintec50',  group: 'vintec', shelves: 5, cols: 5, shelfRows: [2, 2, 2, 2, 2], twoDeep: true, capacity: 50 },
  { key: 'vintec148', group: 'vintec', shelves: 5, cols: 7, shelfRows: [5, 4, 4, 4, 4], twoDeep: true, capacity: 148 },

  // ── Liebherr GrandCru (single temperature, long-term storage) ────────────
  // Small built-ins hold one row per wooden shelf.
  { key: 'liebherrWkes653',  group: 'liebherrGrandCru', shelves: 3, cols: 4, shelfRows: [1, 1, 1],          twoDeep: false, capacity: 12 },
  { key: 'liebherrWkes553',  group: 'liebherrGrandCru', shelves: 3, cols: 6, shelfRows: [1, 1, 1],          twoDeep: false, capacity: 18 },
  { key: 'liebherrWkes4552', group: 'liebherrGrandCru', shelves: 6, cols: 8, shelfRows: [5, 5, 4, 4, 4, 3], twoDeep: true,  capacity: 201 },
  { key: 'liebherrWkt6451',  group: 'liebherrGrandCru', shelves: 6, cols: 8, shelfRows: [7, 7, 7, 6, 6, 6], twoDeep: true,  capacity: 312 },
  // WPbl 5001 (glass door) / WSbl 5001 (solid door): 196 bottles in five
  // compartments, front and back sections each — the maker's loading diagram
  // as an owner mapped it against the manual (support tickets 2026-08-31 and
  // 2026-09-15). The three middle shelves stack as a honeycomb four levels
  // high, 6 in front of 5 then 5 in front of 6 (44 each); the top and bottom
  // shelves are four levels of 4 in front of 4, staggered (32 each):
  // 2 × 32 + 3 × 44 = 196 exactly.
  {
    key: 'liebherrWpbl5001', group: 'liebherrGrandCru', shelves: 5, cols: 6, twoDeep: true, alternate: true,
    shelfRows: [8, 8, 8, 8, 8], shelfCols: [4, 6, 6, 6, 4], shelfAlternate: [false, true, true, true, false], capacity: 196,
  },

  // ── Liebherr Vinidor (two or three zones, many single-row shelves) ───────
  { key: 'liebherrWtes1672', group: 'liebherrVinidor', shelves: 6,  cols: 6, shelfRows: [1, 1, 1, 1, 1, 1],                            twoDeep: false, capacity: 34 },
  { key: 'liebherrWtes4677', group: 'liebherrVinidor', shelves: 13, cols: 8, shelfRows: [2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1],       twoDeep: true,  capacity: 143 },
  { key: 'liebherrWtes5872', group: 'liebherrVinidor', shelves: 13, cols: 8, shelfRows: [2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1],       twoDeep: true,  capacity: 178 },
  { key: 'liebherrWtes5972', group: 'liebherrVinidor', shelves: 13, cols: 8, shelfRows: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],       twoDeep: true,  capacity: 211 },

  // ── Liebherr Vinothek (single temperature, stacked bays) ─────────────────
  { key: 'liebherrWkb4212', group: 'liebherrVinothek', shelves: 5, cols: 6, shelfRows: [7, 7, 7, 6, 6], twoDeep: true, capacity: 200 },

  // ── Generic ──────────────────────────────────────────────────────────────
  { key: 'sliding', group: 'generic', shelves: 6, cols: 6, shelfRows: [2, 2, 2, 2, 2, 2], twoDeep: true },
];

/** Default shape when the user picks the cabinet type with no preset. */
export const CABINET_DEFAULT = { shelves: 5, cols: 6, shelfRows: [2, 2, 2, 2, 2], twoDeep: true, stagger: true, alternate: false };

export const CABINET_MAX_ROWS_PER_SHELF = 12;

/**
 * Normalise a shelfRows list against a shelf count: pads with 1s, trims,
 * clamps each entry to 1..CABINET_MAX_ROWS_PER_SHELF. Used by the create
 * form so the list always matches the shelves input.
 */
export function fitShelfRows(shelfRows, shelves) {
  const n = Math.max(1, Math.min(20, parseInt(shelves, 10) || 1));
  const src = Array.isArray(shelfRows) ? shelfRows : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = parseInt(src[i], 10);
    out.push(Number.isFinite(v) ? Math.max(1, Math.min(CABINET_MAX_ROWS_PER_SHELF, v)) : 1);
  }
  return out;
}

/**
 * Capacity of a cabinet shape. `typeConfig` carries twoDeep / alternate and
 * the per-shelf lists — an alternating or narrower shelf is not cols × rows,
 * so the count is the geometry's (rackLayouts.getTotalSlots).
 */
export function cabinetCapacity(cols, shelfRows, typeConfig) {
  const list = Array.isArray(shelfRows) ? shelfRows : [];
  return getTotalSlots('cabinet', list.length, parseInt(cols, 10) || 0, { ...(typeConfig || {}), shelfRows: list });
}
