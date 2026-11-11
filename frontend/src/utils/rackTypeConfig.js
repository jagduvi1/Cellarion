import { CABINET_DEFAULT, fitShelfRows } from './cabinetPresets';
import { cabinetShelfCols, cabinetShelfAlternate, cabinetShelfSideways } from './rackLayouts';

// The options only a cabinet may carry (the backend rejects them on any other type).
const CABINET_KEYS = ['shelfRows', 'twoDeep', 'stagger', 'headToTail', 'alternate', 'shelfCols', 'shelfAlternate', 'shelfSideways'];

/**
 * The type options a new rack starts with when its type is picked in the
 * "new rack" form (pages/CellarRacks). A type without options of its own gets
 * an empty object.
 */
export function defaultTypeConfig(type) {
  if (type === 'cube') return { moduleRows: 2, moduleCols: 2 };
  if (type === 'x-rack') return { bottlesPerSection: 10 };
  if (type === 'shelf') return { bottlesPerCell: 1, backCols: 0 };
  if (type === 'cabinet') {
    return {
      shelfRows: [...CABINET_DEFAULT.shelfRows],
      twoDeep: CABINET_DEFAULT.twoDeep,
      stagger: CABINET_DEFAULT.stagger,
      alternate: CABINET_DEFAULT.alternate,
    };
  }
  return {};
}

/**
 * The typeConfig to send when the "new rack" form is submitted: the form's
 * options made to fit the rows and columns it ends with, which may have been
 * changed after the options were typed. Returns undefined when the form holds
 * no option at all; the request then carries no typeConfig.
 *
 * `rack` is the form's state: { type, rows, cols, typeConfig }.
 */
export function createRackTypeConfig({ type, rows, cols, typeConfig: formConfig }) {
  if (!formConfig || Object.keys(formConfig).length === 0) return undefined;
  const typeConfig = { ...formConfig };
  // Drop double-height rows outside the final row count — the rows
  // input may have been lowered after they were typed, and the
  // backend rejects out-of-range entries with a 400.
  if (Array.isArray(typeConfig.doubleHeightRows)) {
    typeConfig.doubleHeightRows = typeConfig.doubleHeightRows
      .filter(r => r >= 1 && r <= rows);
    if (typeConfig.doubleHeightRows.length === 0) delete typeConfig.doubleHeightRows;
  }
  // Cabinet: the per-shelf list must match the final shelf count (the
  // rows input may have changed after the list was edited); other
  // types must not carry cabinet keys (the backend rejects them).
  if (type === 'cabinet') {
    typeConfig.shelfRows = fitShelfRows(typeConfig.shelfRows, rows);
    typeConfig.twoDeep = typeConfig.twoDeep !== false;
    typeConfig.stagger = typeConfig.stagger !== false;
    typeConfig.alternate = typeConfig.alternate === true;
    // Head to tail is for a one-deep cabinet only (the backend refuses
    // it with two deep), and stored only when on.
    if (typeConfig.twoDeep === false && typeConfig.headToTail === true) typeConfig.headToTail = true; else delete typeConfig.headToTail;
    // Per-shelf width / pattern: fitted to the final shelf count and
    // width, and stored only where a shelf differs from the cabinet.
    const widths = cabinetShelfCols(rows, cols, typeConfig);
    if (widths.some((w) => w !== cols)) typeConfig.shelfCols = widths; else delete typeConfig.shelfCols;
    const patterns = cabinetShelfAlternate(rows, typeConfig);
    if (patterns.some((a) => a !== typeConfig.alternate)) typeConfig.shelfAlternate = patterns; else delete typeConfig.shelfAlternate;
    // How each shelf's bottles lie (drawing only): fitted to the final
    // shelf count, and stored only when some shelf lies sideways.
    const lies = cabinetShelfSideways(rows, typeConfig);
    if (lies.some(Boolean)) typeConfig.shelfSideways = lies; else delete typeConfig.shelfSideways;
  } else {
    for (const k of CABINET_KEYS) delete typeConfig[k];
  }
  return typeConfig;
}
