/**
 * Starting shapes for the `cabinet` rack type (wine fridges / climate
 * cabinets). A preset seeds shelves, width, and per-shelf stack heights; the
 * user then edits them. They are STARTING SHAPES, never the truth: makers
 * ship a cabinet with sliding shelves and tell owners to pull shelves out
 * and stack bottles to reach the advertised capacity, so two owners of the
 * same model end up with different layouts (an imported Oeno file showed a
 * "148" running 6 shelves with up to 10 stacked rows).
 *
 * Shape: { key, shelves, cols, shelfRows, twoDeep } — see CABINET contract in
 * rackLayouts.cabinetLayout for what each field means.
 */
export const CABINET_PRESETS = [
  { key: 'vintec50',   shelves: 5, cols: 5, shelfRows: [2, 2, 2, 2, 2],    twoDeep: true },
  { key: 'vintec148',  shelves: 5, cols: 7, shelfRows: [4, 4, 4, 4, 4],    twoDeep: true },
  { key: 'sliding',    shelves: 6, cols: 6, shelfRows: [2, 2, 2, 2, 2, 2], twoDeep: true },
];

/** Default shape when the user picks the cabinet type with no preset. */
export const CABINET_DEFAULT = { shelves: 5, cols: 6, shelfRows: [2, 2, 2, 2, 2], twoDeep: true };

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

/** Capacity of a cabinet shape. */
export function cabinetCapacity(cols, shelfRows) {
  const c = parseInt(cols, 10) || 0;
  return (Array.isArray(shelfRows) ? shelfRows : []).reduce((sum, r) => sum + c * (parseInt(r, 10) || 0), 0);
}
