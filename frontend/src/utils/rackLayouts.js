/**
 * Rack layout engine — computes SVG coordinates for each slot position per rack type.
 *
 * Returns { totalSlots, viewBox: { width, height }, slots: [{ position, cx, cy }] }
 *
 * Position numbering is 1-based and contiguous (1 through totalSlots).
 */

const SLOT_R = 20;       // slot circle radius
const SLOT_GAP = 8;      // gap between slots
const PADDING = 20;       // viewBox padding
const CELL = SLOT_R * 2 + SLOT_GAP;  // centre-to-centre distance

// Extra headroom (in cell heights) inserted above each double-height row,
// and the amount its top-layer bottles are raised above the base row.
export const DOUBLE_ROW_HEADROOM = 0.8;

/**
 * Filter typeConfig.doubleHeightRows down to the entries that actually
 * contribute top-layer capacity: unique integers in [1, rows], ascending.
 * A row only fits a top layer when cols > 1. Mirrors backend
 * rackGeometry.validDoubleHeightRows.
 */
export function validDoubleHeightRows(rows, cols, doubleHeightRows) {
  if (!Array.isArray(doubleHeightRows) || cols <= 1) return [];
  return [...new Set(doubleHeightRows)]
    .filter(r => Number.isInteger(r) && r >= 1 && r <= rows)
    .sort((a, b) => a - b);
}

// ── Grid ─────────────────────────────────────────────────────────────
// POSITION NUMBERING CONTRACT (double-height rows): the base grid keeps
// positions 1..rows*cols row-major EXACTLY as a plain grid — existing
// bottles never move. Top-layer positions are APPENDED after rows*cols:
// iterate valid double-height rows in ascending row order, each contributing
// cols-1 positions left-to-right (bottles resting in the gaps between base
// bottles). Example 4x6 grid with doubleHeightRows [2]: base 1..24
// unchanged, top layer of row 2 = positions 25..29.
function gridLayout(rows, cols, typeConfig) {
  const doubles = validDoubleHeightRows(rows, cols, typeConfig?.doubleHeightRows);
  const doubleSet = new Set(doubles);
  const extra = CELL * DOUBLE_ROW_HEADROOM;

  // Cumulative headroom: each double row pushes itself and every row below
  // it down by `extra`, so rows keep their visual identity — only extra
  // space appears above each double row.
  const yOffset = new Array(rows);
  let acc = 0;
  for (let r = 0; r < rows; r++) {
    if (doubleSet.has(r + 1)) acc += extra;
    yOffset[r] = acc;
  }
  const rowCy = (r) => PADDING + SLOT_R + r * CELL + (yOffset[r] || 0);

  const slots = [];
  let pos = 1;
  // Base grid: positions 1..rows*cols, row-major — same as a plain grid.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL,
        cy: rowCy(r),
      });
    }
  }
  // Top layer: appended after rows*cols, ascending row order, left-to-right.
  // Each top bottle sits centred in the gap between two base bottles
  // (x staggered by half a cell) and raised into the row's headroom.
  for (const d of doubles) {
    const r = d - 1;
    for (let c = 0; c < cols - 1; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + (c + 0.5) * CELL,
        cy: rowCy(r) - extra,
        isTop: true,
      });
    }
  }

  // With double rows, the generic midpoint heuristic in ShelfLines would
  // draw a plank between a top layer and its base row — emit explicit
  // shelf positions instead: between row r's bottles and whatever tops
  // row r+1 (its top layer when double, its base bottles otherwise).
  let shelfYs;
  if (doubles.length > 0 && rows > 1) {
    shelfYs = [];
    for (let r = 0; r < rows - 1; r++) {
      const below = rowCy(r) + SLOT_R;
      const aboveNext = rowCy(r + 1) - (doubleSet.has(r + 2) ? extra : 0) - SLOT_R;
      shelfYs.push((below + aboveNext) / 2);
    }
  }

  return {
    totalSlots: slots.length,
    shelfYs,
    viewBox: {
      width:  PADDING * 2 + cols * CELL - SLOT_GAP,
      height: PADDING * 2 + rows * CELL - SLOT_GAP + doubles.length * extra,
    },
    slots,
  };
}

// ── X-Rack ──────────────────────────────────────────────────────────
// Square with X-shaped dividers creating 4 triangular sections.
// Each section holds bottlesPerSection bottles arranged in triangular rows.
// Sections: 0=top, 1=right, 2=bottom, 3=left
function xRackLayout(typeConfig) {
  const bps = typeConfig?.bottlesPerSection || 10;
  const total = 4 * bps;

  // Number of rows per section for triangular stacking: k*(k+1)/2 >= bps
  let k = 1;
  while (k * (k + 1) / 2 < bps) k++;

  // Spacing between bottles within the triangular sections
  const rowStep = CELL * 0.78;
  const colStep = CELL * 0.82;
  const centerGap = CELL * 0.35;

  // Half-side: from center to edge, must fit k rows of bottles
  const halfSide = k * rowStep + centerGap + SLOT_R;
  const fullSize = halfSide * 2;
  const cx = PADDING + halfSide;
  const cy = PADDING + halfSide;

  const slots = [];
  let pos = 1;

  for (let section = 0; section < 4; section++) {
    let placed = 0;
    for (let row = 0; row < k && placed < bps; row++) {
      const bottlesInRow = Math.min(k - row, bps - placed);
      // Distance from center: row 0 = outermost (near wall), row k-1 = innermost (near center)
      const distFromCenter = halfSide - SLOT_R - row * rowStep;

      for (let col = 0; col < bottlesInRow; col++) {
        const lateral = (col - (bottlesInRow - 1) / 2) * colStep;
        let sx, sy;
        switch (section) {
          case 0: // top: base at top edge
            sx = cx + lateral;
            sy = cy - distFromCenter;
            break;
          case 1: // right: base at right edge
            sx = cx + distFromCenter;
            sy = cy + lateral;
            break;
          case 2: // bottom: base at bottom edge
            sx = cx - lateral;
            sy = cy + distFromCenter;
            break;
          case 3: // left: base at left edge
            sx = cx - distFromCenter;
            sy = cy - lateral;
            break;
          default:
            sx = cx;
            sy = cy;
        }
        slots.push({ position: pos++, cx: sx, cy: sy });
        placed++;
      }
    }
  }

  return {
    totalSlots: total,
    isXRack: true,
    viewBox: {
      width:  PADDING * 2 + fullSize,
      height: PADDING * 2 + fullSize,
    },
    slots,
  };
}

// ── Hexagonal honeycomb ──────────────────────────────────────────────
// Even rows (0-indexed) have `cols` slots; odd rows have `cols - 1` (offset right by half).
// typeConfig.hexFlip mirrors the row sequence top-to-bottom: row r reads the
// width the UNFLIPPED row (rows-1-r) would have had. Pure reversal of the
// same multiset of widths — never changes total slot count.
// typeConfig.hexEqualRows keeps every row at the full `cols` count with the
// offset rows still staggered by half a slot (the equal-row shelf in wine
// fridges, effectively cols+0.5 wide) — total becomes rows × cols. Composes
// with hexFlip, which still decides WHICH rows are offset.
function hexLayout(rows, cols, typeConfig) {
  const flipped = !!typeConfig?.hexFlip;
  const equalRows = !!typeConfig?.hexEqualRows;
  const slots = [];
  let pos = 1;
  const hexH = CELL * 0.866;  // vertical distance (sin 60° ≈ 0.866)

  for (let r = 0; r < rows; r++) {
    const rr = flipped ? (rows - 1 - r) : r;
    const isOdd = rr % 2 === 1;
    const rowCols = equalRows ? cols : (isOdd ? Math.max(1, cols - 1) : cols);
    const xOffset = isOdd ? CELL * 0.5 : 0;

    for (let c = 0; c < rowCols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL + xOffset,
        cy: PADDING + SLOT_R + r * hexH,
      });
    }
  }

  return {
    totalSlots: slots.length,
    viewBox: {
      // Classic hex already reserves the half-cell stagger for cols > 1; an
      // equal-rows rack needs it at any width (offset rows genuinely extend
      // half a slot past the even rows, even at cols = 1).
      width:  PADDING * 2 + cols * CELL - SLOT_GAP + (cols > 1 || equalRows ? CELL * 0.5 : 0),
      height: PADDING * 2 + (rows - 1) * hexH + SLOT_R * 2,
    },
    slots,
  };
}

// ── Triangle (A-frame) ───────────────────────────────────────────────
// Row 0 has `base` slots, row 1 has `base - 1`, etc. down to 1.
function triangleLayout(_rows, cols) {
  const base = Math.max(1, cols);
  const numRows = base;
  const slots = [];
  let pos = 1;

  for (let r = 0; r < numRows; r++) {
    const rowCols = base - r;
    const xOffset = (r * CELL) / 2;  // centre each narrowing row
    for (let c = 0; c < rowCols; c++) {
      slots.push({
        position: pos++,
        cx: PADDING + SLOT_R + c * CELL + xOffset,
        cy: PADDING + SLOT_R + r * CELL,
      });
    }
  }

  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + base * CELL - SLOT_GAP,
      height: PADDING * 2 + numRows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── Stack (single column) ────────────────────────────────────────────
function stackLayout(rows) {
  const slots = [];
  for (let r = 0; r < rows; r++) {
    slots.push({
      position: r + 1,
      cx: PADDING + SLOT_R,
      cy: PADDING + SLOT_R + r * CELL,
    });
  }
  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + SLOT_R * 2,
      height: PADDING * 2 + rows * CELL - SLOT_GAP,
    },
    slots,
  };
}

// ── Cube (grid of sub-modules) ───────────────────────────────────────
// Outer grid = rows × cols modules. Each module = moduleRows × moduleCols.
// Modules are separated by extra spacing.
function cubeLayout(rows, cols, typeConfig) {
  const mr = typeConfig?.moduleRows || 2;
  const mc = typeConfig?.moduleCols || 2;
  const moduleGap = CELL * 0.6;  // extra gap between modules
  const slots = [];
  let pos = 1;

  for (let outerR = 0; outerR < rows; outerR++) {
    for (let outerC = 0; outerC < cols; outerC++) {
      const moduleX = outerC * (mc * CELL + moduleGap);
      const moduleY = outerR * (mr * CELL + moduleGap);

      for (let innerR = 0; innerR < mr; innerR++) {
        for (let innerC = 0; innerC < mc; innerC++) {
          slots.push({
            position: pos++,
            cx: PADDING + SLOT_R + moduleX + innerC * CELL,
            cy: PADDING + SLOT_R + moduleY + innerR * CELL,
          });
        }
      }
    }
  }

  const totalW = cols * mc * CELL + (cols - 1) * moduleGap;
  const totalH = rows * mr * CELL + (rows - 1) * moduleGap;

  return {
    totalSlots: slots.length,
    viewBox: {
      width:  PADDING * 2 + totalW - SLOT_GAP,
      height: PADDING * 2 + totalH - SLOT_GAP,
    },
    slots,
  };
}

// ── Shelf (open case storage) ────────────────────────────────────────
// Grid of compartments; each holds bottlesPerCell bottles.
// Optional backCols: staggered back row per shelf, dimmed/smaller for depth.
const BACK_R = SLOT_R * 0.7;
const BACK_INTRA_GAP = 22;

function shelfLayout(rows, cols, typeConfig) {
  const bpc = typeConfig?.bottlesPerCell || 1;
  const backCols = Math.max(0, typeConfig?.backCols || 0);
  const hasBack = backCols > 0;

  const compartmentH = hasBack
    ? BACK_R * 2 + BACK_INTRA_GAP + CELL
    : CELL;

  const slots = [];
  const shelfYs = [];
  let pos = 1;

  for (let r = 0; r < rows; r++) {
    const compartmentTopY = PADDING + r * compartmentH;
    const frontCY = hasBack
      ? compartmentTopY + BACK_R * 2 + BACK_INTRA_GAP + SLOT_R
      : compartmentTopY + SLOT_R;
    const backCY = compartmentTopY + BACK_R;

    for (let c = 0; c < cols; c++) {
      const cx = PADDING + SLOT_R + c * CELL;
      for (let b = 0; b < bpc; b++) {
        slots.push({ position: pos++, cx, cy: frontCY });
      }
    }

    if (hasBack) {
      for (let c = 0; c < backCols; c++) {
        const cx = PADDING + SLOT_R + (c + 0.5) * CELL;
        for (let b = 0; b < bpc; b++) {
          slots.push({ position: pos++, cx, cy: backCY, isBack: true });
        }
      }
    }

    if (r < rows - 1) {
      shelfYs.push(compartmentTopY + compartmentH - SLOT_GAP / 2);
    }
  }

  const maxRightFront = cols > 0 ? PADDING + SLOT_R + (cols - 1) * CELL + SLOT_R : 0;
  const maxRightBack = hasBack ? PADDING + SLOT_R + (backCols - 0.5) * CELL + BACK_R : 0;
  const contentRight = Math.max(maxRightFront, maxRightBack);

  return {
    totalSlots: slots.length,
    bottlesPerCell: bpc,
    backRadius: hasBack ? BACK_R : undefined,
    shelfYs: hasBack ? shelfYs : undefined,
    viewBox: {
      width:  contentRight + PADDING,
      height: PADDING * 2 + rows * compartmentH - SLOT_GAP,
    },
    slots,
  };
}

// ── Cabinet (wine fridge / climate cabinet) ─────────────────────────
// `rows` shelves top to bottom; shelf i is a bay holding shelfRows[i] rows
// of `cols` bottles (1 = a sliding shelf with one row, more = a stacking
// bay). With stagger (the default) each stacked level nests in the grooves of
// the level below, offset half a bottle and sitting √3/2 of a diameter higher
// — drawing only, the numbering contract below never changes.
// With twoDeep the rows pair up neck to neck: row 1 = bottom front,
// row 2 = bottom back, row 3 = next level front, … — the back row of a level
// is drawn as a smaller circle peeking up between the front bottles, like
// shelfLayout's back row.
//
// With alternate the rows are not all `cols` wide: they alternate cols /
// cols−1 like a honeycomb (cabinetRowWidth) — the narrow rows are the ones
// drawn offset, centred in the gaps of the wide rows, so the shelf is exactly
// cols bottles wide and every level nests (alternate implies stagger).
// A shelf may also have its own width (shelfCols[i] ≤ cols) and its own
// pattern (shelfAlternate[i]); cabinetBays resolves them, and a narrower bay
// is drawn centred in the cabinet.
//
// POSITION NUMBERING CONTRACT (mirrors backend rackGeometry.cabinetPosition):
//   position = cols × Σ_{k<i} shelfRows[k] + (row − 1) × cols + slot
// rows counted from the plank up, slots left to right; in general (an
// alternating cabinet) position = Σ widths of every earlier row + slot.
// twoDeep never changes the numbering, only where a row is drawn.
export const CABINET_MAX_ROWS_PER_SHELF = 12;

/** Per-shelf row list fitted to `rows` (missing → 1, clamped 1..12). */
export function cabinetShelfRows(rows, typeConfig) {
  const n = Math.max(0, Math.min(20, parseInt(rows, 10) || 0));
  const src = Array.isArray(typeConfig?.shelfRows) ? typeConfig.shelfRows : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = parseInt(src[i], 10);
    out.push(Number.isFinite(v) ? Math.max(1, Math.min(CABINET_MAX_ROWS_PER_SHELF, v)) : 1);
  }
  return out;
}

/** The shape flags of a cabinet's typeConfig with their defaults (mirrors backend cabinetOptions). */
export function cabinetOptions(typeConfig) {
  return { twoDeep: typeConfig?.twoDeep !== false, alternate: typeConfig?.alternate === true };
}

/**
 * Bottles in row `row` (1-based, from the plank) of a cabinet bay: `cols`,
 * unless the cabinet alternates — then the first level's front row holds
 * cols, its back row one fewer, the level above one fewer in front of cols,
 * and so on; single-deep levels alternate cols, cols−1, cols, … Mirrors
 * backend rackGeometry.cabinetRowWidth. Never 0 wide.
 */
export function cabinetRowWidth(row, cols, { twoDeep = true, alternate = false } = {}) {
  if (!alternate) return cols;
  const level = twoDeep ? Math.ceil(row / 2) : row;
  const isBack = twoDeep && row % 2 === 0;
  const wide = (level % 2 === 1) !== isBack;
  return wide ? cols : Math.max(1, cols - 1);
}

/** Bottles a bay of `rowCount` rows holds (mirrors backend cabinetBayCapacity). */
export function cabinetBayCapacity(rowCount, cols, opts) {
  if (!opts?.alternate) return cols * rowCount;
  let n = 0;
  for (let r = 1; r <= rowCount; r++) n += cabinetRowWidth(r, cols, opts);
  return n;
}

/** Per-shelf widths fitted to `rows` (missing → cols, clamped 1..cols). Mirrors the backend. */
export function cabinetShelfCols(rows, cols, typeConfig) {
  const n = Math.max(0, Math.min(20, parseInt(rows, 10) || 0));
  const full = Math.max(1, Math.min(20, parseInt(cols, 10) || 1));
  const src = Array.isArray(typeConfig?.shelfCols) ? typeConfig.shelfCols : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = parseInt(src[i], 10);
    out.push(Number.isFinite(v) ? Math.max(1, Math.min(full, v)) : full);
  }
  return out;
}

/** Per-shelf alternate flags fitted to `rows` (missing → the cabinet's alternate). Mirrors the backend. */
export function cabinetShelfAlternate(rows, typeConfig) {
  const n = Math.max(0, Math.min(20, parseInt(rows, 10) || 0));
  const fallback = typeConfig?.alternate === true;
  const src = Array.isArray(typeConfig?.shelfAlternate) ? typeConfig.shelfAlternate : [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(typeof src[i] === 'boolean' ? src[i] : fallback);
  return out;
}

/**
 * Every bay top first with its resolved shape { rows, cols, alternate } —
 * the one place the per-shelf lists are combined (mirrors backend cabinetBays).
 */
export function cabinetBays(rows, cols, typeConfig) {
  const rowList = cabinetShelfRows(rows, typeConfig);
  const colList = cabinetShelfCols(rows, cols, typeConfig);
  const altList = cabinetShelfAlternate(rows, typeConfig);
  return rowList.map((r, i) => ({ rows: r, cols: colList[i], alternate: altList[i] }));
}

/**
 * How many bottle widths a bay spans when drawn: its width plus the half
 * bottle a two-deep back row or a nested full-width level pokes out (an
 * alternating bay never does — its offset rows are the narrow ones).
 */
export function cabinetBayUnits(bay, { twoDeep, stagger }) {
  if (bay.alternate) return bay.cols;
  return bay.cols + (twoDeep ? 0.5 : 0) + (stagger && bay.cols > 1 ? 0.5 : 0);
}

const CAB_BACK_R = SLOT_R * 0.72;
const CAB_BACK_LIFT = SLOT_R * 0.9;   // how far a back bottle peeks above its front row
const CAB_PLANK = SLOT_GAP * 2;        // extra room under each plank
// A level nested in the grooves of the level below sits lower than one stacked
// squarely on top: centres of touching circles offset by half a diameter are
// √3/2 apart vertically. Same ratio the hex layout uses.
const CAB_NEST_RATIO = Math.sqrt(3) / 2;

function cabinetLayout(rows, cols, typeConfig) {
  const shelfRows = cabinetShelfRows(rows, typeConfig);
  const bayShapes = cabinetBays(rows, cols, typeConfig);
  const { twoDeep } = cabinetOptions(typeConfig);
  const stagger = typeConfig?.stagger !== false;
  // Every bay alternates → the cabinet does; drawn nesting follows per bay
  // (a narrow row can only lie in the grooves of the wide row below, so an
  // alternating bay always nests, whatever stagger says).
  const alternate = bayShapes.length > 0 && bayShapes.every((b) => b.alternate);
  const nestOf = (bay) => bay.alternate || stagger;
  // The cabinet is as wide as its widest bay when drawn; narrower bays sit
  // centred inside it, like the 4-wide top shelf of a 6-wide GrandCru.
  const units = Math.max(1, ...bayShapes.map((b) => cabinetBayUnits(b, { twoDeep, stagger })));
  const slots = [];
  const shelfYs = [];
  const bays = [];
  let pos = 1;
  let y = PADDING;

  bayShapes.forEach((bay, i) => {
    const rowCount = bay.rows;
    const levels = twoDeep ? Math.ceil(rowCount / 2) : rowCount;
    const nest = nestOf(bay);
    // Level pitch: a full bottle plus, when two deep, the lift of the back
    // row. Nested levels sit CAB_NEST_RATIO closer together — but the FIRST
    // level rests on the plank, so only the levels above it are nested (same
    // formula as roomConstants.getCabinetGeometry).
    const baseH = CELL + (twoDeep ? CAB_BACK_LIFT : 0);
    const levelH = (nest ? CELL * CAB_NEST_RATIO : CELL) + (twoDeep ? CAB_BACK_LIFT : 0);
    const bayTop = y;
    const bayH = baseH + Math.max(0, levels - 1) * levelH + CAB_PLANK;
    const x0 = PADDING + SLOT_R + ((units - cabinetBayUnits(bay, { twoDeep, stagger })) / 2) * CELL;
    // Rows are numbered from the plank UP, so the last level is drawn at the
    // top of the bay and row 1 at the bottom (resting on the plank).
    for (let r = 1; r <= rowCount; r++) {
      const level = twoDeep ? Math.ceil(r / 2) : r;
      const isBack = twoDeep && r % 2 === 0;
      const levelBottomY = bayTop + bayH - CAB_PLANK - (level - 1) * levelH;
      const frontCY = levelBottomY - SLOT_R;
      const backCY = frontCY - CAB_BACK_LIFT;
      // Nested levels alternate half a bottle left and right, so the shelf
      // is half a bottle wider than its bottle count — the equal-rows
      // staggered shelf of a real fridge (same model as hexEqualRows).
      // Alternating bay: the NARROW rows are the offset ones, centred in
      // the gaps of the wide rows (front and back alike), and the shelf is
      // exactly its width — the classic honeycomb.
      const width = cabinetRowWidth(r, bay.cols, { twoDeep, alternate: bay.alternate });
      const nudge = bay.alternate
        ? (width < bay.cols ? 0.5 : 0)
        : (nest && bay.cols > 1 && level % 2 === 0 ? 0.5 : 0);
      for (let c = 0; c < width; c++) {
        const cx = isBack && !bay.alternate
          ? x0 + (c + 0.5 + nudge) * CELL
          : x0 + (c + nudge) * CELL;
        slots.push({
          position: pos++, cx, cy: isBack ? backCY : frontCY,
          ...(isBack ? { isBack: true } : {}),
          ...(!isBack && level > 1 ? { isTop: true } : {}),
        });
      }
    }
    bays.push({ index: i, top: bayTop, height: bayH, rows: rowCount, levels, cols: bay.cols, alternate: bay.alternate });
    y += bayH;
    if (i < bayShapes.length - 1) shelfYs.push(y - SLOT_GAP / 2);
  });

  const contentRight = PADDING + SLOT_R + (units - 1) * CELL + SLOT_R;
  return {
    totalSlots: slots.length,
    bottlesPerCell: 1,
    backRadius: twoDeep ? CAB_BACK_R : undefined,
    shelfYs: shelfYs.length ? shelfYs : undefined,
    cabinet: { shelfRows, twoDeep, stagger: alternate || stagger, alternate, bays },
    viewBox: {
      width: contentRight + PADDING,
      height: y + PADDING - SLOT_GAP,
    },
    slots,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Compute the layout for a given rack type.
 * @param {string} type - one of: grid, x-rack, hex, triangle, stack, cube, shelf, cabinet
 * @param {number} rows
 * @param {number} cols
 * @param {object} [typeConfig] - extra config (e.g. moduleRows/moduleCols for cube)
 * @returns {{ totalSlots: number, viewBox: { width: number, height: number }, slots: Array<{ position: number, cx: number, cy: number }> }}
 */
export function computeLayout(type, rows, cols, typeConfig) {
  switch (type) {
    case 'x-rack':   return xRackLayout(typeConfig);
    case 'hex':      return hexLayout(rows, cols, typeConfig);
    case 'triangle': return triangleLayout(rows, cols);
    case 'stack':    return stackLayout(rows);
    case 'cube':     return cubeLayout(rows, cols, typeConfig);
    case 'shelf':    return shelfLayout(rows, cols, typeConfig);
    case 'cabinet':  return cabinetLayout(rows, cols, typeConfig);
    case 'grid':
    default:         return gridLayout(rows, cols, typeConfig);
  }
}

/** Slot radius — exported so renderers can use it. */
export const SLOT_RADIUS = SLOT_R;

/** Centre-to-centre distance — exported for builder grid snapping. */
export const CELL_SIZE = CELL;

/**
 * Compute layout for a modular rack (multiple modules composed together).
 * Each module gets its own sub-layout, offset by (module.x, module.y) in grid-cell units.
 * Slot positions are globally contiguous across all modules.
 *
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object, x?: number, y?: number }>} modules
 * @returns {{ totalSlots: number, viewBox: { width: number, height: number }, slots: Array<{ position: number, cx: number, cy: number, moduleIndex: number }>, moduleLayouts: Array<{ moduleIndex: number, x: number, y: number, width: number, height: number, slotCount: number }> }}
 */
export function computeModularLayout(modules) {
  if (!modules || modules.length === 0) {
    return { totalSlots: 0, viewBox: { width: 0, height: 0 }, slots: [], moduleLayouts: [] };
  }

  let globalPos = 1;
  let maxRight = 0;
  let maxBottom = 0;
  const allSlots = [];
  const moduleLayouts = [];

  modules.forEach((mod, idx) => {
    const sub = computeLayout(mod.type || 'grid', mod.rows || 1, mod.cols || 1, mod.typeConfig);
    const offsetX = (mod.x || 0) * CELL;
    const offsetY = (mod.y || 0) * CELL;

    const modSlots = sub.slots.map(s => ({
      position: globalPos++,
      cx: s.cx + offsetX,
      cy: s.cy + offsetY,
      moduleIndex: idx,
    }));

    allSlots.push(...modSlots);

    const modRight = offsetX + sub.viewBox.width;
    const modBottom = offsetY + sub.viewBox.height;
    if (modRight > maxRight) maxRight = modRight;
    if (modBottom > maxBottom) maxBottom = modBottom;

    moduleLayouts.push({
      moduleIndex: idx,
      x: offsetX,
      y: offsetY,
      width: sub.viewBox.width,
      height: sub.viewBox.height,
      slotCount: sub.totalSlots,
    });
  });

  return {
    totalSlots: allSlots.length,
    viewBox: { width: maxRight, height: maxBottom },
    slots: allSlots,
    moduleLayouts,
  };
}

/**
 * Quick modular total slot count without computing coordinates.
 * @param {Array<{ type: string, rows: number, cols: number, typeConfig?: object }>} modules
 * @returns {number}
 */
export function getModularTotalSlots(modules) {
  if (!modules || modules.length === 0) return 0;
  return modules.reduce((sum, m) => sum + getTotalSlots(m.type || 'grid', m.rows || 1, m.cols || 1, m.typeConfig), 0);
}

/**
 * Quick total slot count without computing full coordinates.
 * Mirrors backend rackGeometry.totalSlots.
 */
export function getTotalSlots(type, rows, cols, typeConfig) {
  switch (type) {
    case 'x-rack': {
      const bps = typeConfig?.bottlesPerSection || 10;
      return 4 * bps;
    }
    case 'hex': {
      // Equal-row stagger: every row full width, total = rows × cols.
      // Mirrors backend rackGeometry.totalSlots. hexFlip is deliberately
      // not read — a pure reversal can never change the total.
      if (typeConfig?.hexEqualRows) return rows * cols;
      let total = 0;
      for (let r = 0; r < rows; r++) {
        total += (r % 2 === 0) ? cols : Math.max(1, cols - 1);
      }
      return total;
    }
    case 'triangle': {
      const base = Math.max(1, cols);
      return (base * (base + 1)) / 2;
    }
    case 'stack':
      return rows;
    case 'cube': {
      const mr = typeConfig?.moduleRows || 2;
      const mc = typeConfig?.moduleCols || 2;
      return rows * cols * mr * mc;
    }
    case 'shelf': {
      const backCols = Math.max(0, typeConfig?.backCols || 0);
      const cells = rows * (cols + backCols);
      const bpc = typeConfig?.bottlesPerCell || 1;
      return cells * bpc;
    }
    case 'cabinet': {
      // Σ over bays of the bay's own capacity (cols × rows, or the honeycomb
      // sum when it alternates) — mirrors backend rackGeometry.totalSlots.
      const { twoDeep } = cabinetOptions(typeConfig);
      return cabinetBays(rows, cols, typeConfig)
        .reduce((sum, bay) => sum + cabinetBayCapacity(bay.rows, bay.cols, { twoDeep, alternate: bay.alternate }), 0);
    }
    case 'grid':
    default: {
      // POSITION NUMBERING CONTRACT (double-height rows): base grid keeps
      // positions 1..rows*cols row-major EXACTLY as a plain grid; top-layer
      // positions are APPENDED after rows*cols, ascending row order,
      // cols-1 per double row. Mirrors backend rackGeometry.totalSlots.
      const doubles = validDoubleHeightRows(rows, cols, typeConfig?.doubleHeightRows);
      return rows * cols + doubles.length * (cols - 1);
    }
  }
}
