/**
 * The 'wall' rack type: one rack built from boxes on a grid of equal cells.
 *
 * The rack's `rows` × `cols` are the wall's cells. `typeConfig.boxes` lists
 * the boxes; a box covers one cell or a rectangle of them (x, y from the top
 * left, w cells wide, h cells high) and has one content (`kind`):
 *   x          the planks cross: four triangles, `perSection` bottles each
 *   slash      one plank from bottom left to top right: two halves
 *   backslash  one plank from top left to bottom right: two halves
 *   bin        no plank: one pile of `perSection` bottles
 *   rack       `rows` × `cols` single slots
 *   shelves    `rows` shelves of `cols` bottles
 *   closed     holds no bottles (doors, a drawer, decoration)
 * A cell that no box covers is empty wall.
 *
 * POSITION NUMBERING CONTRACT. Positions are contiguous, box after box, the
 * boxes taken top to bottom and left to right by their top-left cell. Inside
 * a box the slots are numbered from 0:
 *   a pile box   section × perSection + i. The sections are, for x: top,
 *                left, right, bottom; for slash: upper left, lower right; for
 *                backslash: upper right, lower left. i counts the bottles of
 *                that pile from the lowest one up (the drawing decides where
 *                that is; frontend utils/wallLayout.js).
 *   rack/shelves row × cols + col, the top row and the left bottle first.
 * So a box's own numbering never depends on any other box, and an edit of the
 * wall can keep every bottle in its box (planWallEdit below).
 *
 * Mirrored by frontend utils/wallLayout.js (wallBoxes, boxCapacity, the
 * section order); both sides run the cases of wallGeometry.cases.json.
 */

const BOX_KINDS = ['x', 'slash', 'backslash', 'bin', 'rack', 'shelves', 'closed'];
// How many separate piles the planks of a box make.
const PILE_SECTIONS = { x: 4, slash: 2, backslash: 2, bin: 1 };
// The piles of a box in the contract's order, as someone at the wall would
// point at them. An open bin is one pile and needs no word.
const SECTION_NAMES = {
  x: ['top', 'left', 'right', 'bottom'],
  slash: ['upper', 'lower'],
  backslash: ['upper', 'lower'],
  bin: [null],
};
const WALL_MAX_PER_SECTION = 60;
// Rows and columns of a rack or shelves box.
const WALL_MAX_BOX_DIM = 20;
// The same ceiling a modular rack has (routes/racks.js MAX_RACK_SLOTS): every
// slot is drawn, one by one, for every member of the cellar.
const WALL_MAX_SLOTS = 10000;

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isPile = (kind) => Object.prototype.hasOwnProperty.call(PILE_SECTIONS, kind);
const isGrid = (kind) => kind === 'rack' || kind === 'shelves';

/** How many bottles a box holds; 0 for a closed box or one that states no valid size. */
function boxCapacity(box) {
  if (!box) return 0;
  if (isPile(box.kind)) {
    return isInt(box.perSection, 1, WALL_MAX_PER_SECTION) ? PILE_SECTIONS[box.kind] * box.perSection : 0;
  }
  if (isGrid(box.kind)) {
    return isInt(box.rows, 1, WALL_MAX_BOX_DIM) && isInt(box.cols, 1, WALL_MAX_BOX_DIM) ? box.rows * box.cols : 0;
  }
  return 0;
}

const inWall = (b, rows, cols) => isInt(b.x, 0, cols - 1) && isInt(b.y, 0, rows - 1)
  && isInt(b.w, 1, cols - b.x) && isInt(b.h, 1, rows - b.y);

/**
 * The boxes of a wall in position order. Defensive like validDoubleHeightRows:
 * a box of an unknown kind or one that does not lie inside the wall is left
 * out, so stored data from before a resize can never give a slot nobody can
 * see. Requests are refused with a message by validateWallConfig instead.
 */
function wallBoxes(rows, cols, typeConfig) {
  const list = typeConfig?.boxes;
  if (!Array.isArray(list)) return [];
  return Array.from(list)
    .filter((b) => b && BOX_KINDS.includes(b.kind) && inWall(b, rows, cols))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Total slots of a wall. Called by rackGeometry.totalSlots for type 'wall'. */
function wallTotalSlots(rows, cols, typeConfig) {
  return wallBoxes(rows, cols, typeConfig).reduce((sum, b) => sum + boxCapacity(b), 0);
}

/** A box's name on the wall: its column as a letter and its row as a number, "B2". */
function boxLabel(box) {
  let n = box.x;
  let letters = '';
  do { letters = String.fromCharCode(65 + (n % 26)) + letters; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return `${letters}${box.y + 1}`;
}

// A stored box has an ObjectId, a request sends its text in either case.
const boxId = (box) => (box._id != null ? String(box._id).toLowerCase() : null);

/**
 * Where each box's positions are: [{ box, id, label, start, capacity }] in
 * position order, the box holding positions start+1 … start+capacity.
 */
function wallRanges(rows, cols, typeConfig) {
  let start = 0;
  return wallBoxes(rows, cols, typeConfig).map((box) => {
    const range = { box, id: boxId(box), label: boxLabel(box), start, capacity: boxCapacity(box) };
    start += range.capacity;
    return range;
  });
}

/**
 * Where a position is, in the words of someone standing at the wall: the box
 * ("B2"), and inside it either the pile and the bottle's count from the
 * bottom of that pile, or the row and the bottle's place in the row.
 * { box, kind, section, slot, row, col }; section and slot are null in a rack
 * or shelves box, row and col in a pile box. null for a position the wall
 * does not have. Mirrored by frontend utils/wallLayout.js wallPlace.
 */
function wallPlace(rows, cols, typeConfig, position) {
  return wallPlacer(rows, cols, typeConfig)(position);
}

/**
 * wallPlace for many positions of one wall: the boxes are walked once, and
 * the function that comes back answers each position. For a caller that
 * reports every bottle of a rack (rackGeometry.slotPlacer).
 */
function wallPlacer(rows, cols, typeConfig) {
  const ranges = wallRanges(rows, cols, typeConfig).filter((r) => r.capacity > 0);
  return (position) => {
    if (!Number.isInteger(position) || position < 1) return null;
    // The ranges are in position order: the last one starting below the position.
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ranges[mid].start < position) lo = mid; else hi = mid - 1;
    }
    const range = ranges[lo];
    if (!range || position <= range.start || position > range.start + range.capacity) return null;
    const { box } = range;
    const index = position - range.start - 1;
    if (isPile(box.kind)) {
      return {
        box: range.label, kind: box.kind,
        section: SECTION_NAMES[box.kind][Math.floor(index / box.perSection)], slot: (index % box.perSection) + 1,
        row: null, col: null,
      };
    }
    return {
      box: range.label, kind: box.kind, section: null, slot: null,
      row: Math.floor(index / box.cols) + 1, col: (index % box.cols) + 1,
    };
  };
}

/**
 * Validate a REQUEST-supplied wall before it is stored. Shared by the create
 * path (services/rackOps.createGridRack) and the REST rack-update route, like
 * validateCabinetConfig. `boxes` on any other rack type is refused as well.
 *
 * @returns {string|null} error message, or null when valid
 */
function validateWallConfig(typeConfig, effectiveType, rows, cols, effectiveModular) {
  const boxes = typeConfig?.boxes;
  const isWall = !effectiveModular && effectiveType === 'wall';
  if (!isWall) {
    return boxes === undefined || boxes === null ? null : 'boxes are only supported on a wall rack';
  }
  if (!Array.isArray(boxes) || boxes.length === 0) return 'A wall needs a boxes list with at least one box';
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return 'A wall needs whole numbers of rows and cols';
  if (boxes.length > rows * cols) return 'A wall cannot have more boxes than cells';

  const taken = new Array(rows * cols).fill(false);
  const ids = new Set();
  let total = 0;
  for (const b of boxes) {
    if (!b || typeof b !== 'object') return 'Each box must be an object';
    if (!BOX_KINDS.includes(b.kind)) return `Invalid box kind. Must be one of: ${BOX_KINDS.join(', ')}`;
    if (!inWall(b, rows, cols)) {
      return `Each box needs whole numbers x, y, w and h that keep it inside the wall (${cols} wide, ${rows} high)`;
    }
    const label = boxLabel(b);
    // A size the box's kind has no use for is stored all the same, so it is
    // held to the same bounds here.
    const sized = (v, max) => v === undefined || v === null || isInt(v, 1, max);
    if (!sized(b.perSection, WALL_MAX_PER_SECTION) || (isPile(b.kind) && !isInt(b.perSection, 1, WALL_MAX_PER_SECTION))) {
      return `Box ${label}: perSection must be a whole number between 1 and ${WALL_MAX_PER_SECTION}`;
    }
    if (!sized(b.rows, WALL_MAX_BOX_DIM) || !sized(b.cols, WALL_MAX_BOX_DIM)
      || (isGrid(b.kind) && !(isInt(b.rows, 1, WALL_MAX_BOX_DIM) && isInt(b.cols, 1, WALL_MAX_BOX_DIM)))) {
      return `Box ${label}: rows and cols must be whole numbers between 1 and ${WALL_MAX_BOX_DIM}`;
    }
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        if (taken[y * cols + x]) return `Box ${label} overlaps another box`;
        taken[y * cols + x] = true;
      }
    }
    // A stored box has an id and a new one states none. null is neither: it
    // would be stored as a box no later edit could follow.
    if (b._id === null) return `Box ${label}: leave _id out for a new box`;
    const id = boxId(b);
    if (id !== null) {
      if (!/^[0-9a-f]{24}$/.test(id)) return `Box ${label}: _id is not a valid id`;
      if (ids.has(id)) return `Box ${label}: two boxes share one _id`;
      ids.add(id);
    }
    total += boxCapacity(b);
  }
  if (total < 1) return 'A wall needs at least one box that holds bottles';
  if (total > WALL_MAX_SLOTS) return `A rack can hold at most ${WALL_MAX_SLOTS} slots in total`;
  return null;
}

/**
 * Everything the numbering of a wall depends on, as one string: while it
 * stays the same, every position is the same place in the same box. The
 * rack-update route compares it across an edit (Rack.renumberedAt).
 */
function wallNumbering(rows, cols, typeConfig) {
  return wallRanges(rows, cols, typeConfig)
    .filter((r) => r.capacity > 0)
    .map(({ box, id, start }) => `${id}:${start}:${box.kind}:${isPile(box.kind) ? box.perSection : `${box.rows}x${box.cols}`}`)
    .join('|');
}

/**
 * The order in which an arrangement fills a wall with `count` bottles, the
 * first bottle (the one to reach for first) first. Boxes are taken one after
 * another from the given corner and each is filled before the next. Bottles
 * in a pile lie on one another, so the bottles a pile gets take its lowest
 * places and the first of them lies on top; a rack or shelves box is read
 * from the same corner. Switched-off positions are left out. The positions
 * that stay empty follow, so the answer lists every usable position once.
 * Callers: the Arrange preview (routes/racks.js) and MCP auto_arrange, which
 * hand it to rackArrange.buildArrangePlan as the fill order.
 */
function wallFillOrder(rows, cols, typeConfig, { count = 0, disabled = [], corner = 'top-left' } = {}) {
  const off = new Set(disabled);
  const fromBottom = String(corner).startsWith('bottom');
  const fromRight = String(corner).endsWith('right');
  const ranges = wallRanges(rows, cols, typeConfig).filter((r) => r.capacity > 0);
  ranges.sort((a, b) => (fromBottom ? (b.box.y + b.box.h) - (a.box.y + a.box.h) : a.box.y - b.box.y)
    || (fromRight ? (b.box.x + b.box.w) - (a.box.x + a.box.w) : a.box.x - b.box.x));
  const filled = [];
  const empty = [];
  let left = Math.max(0, count);
  const steps = (n, backwards) => Array.from({ length: n }, (_, i) => (backwards ? n - 1 - i : i));
  for (const { box, start } of ranges) {
    if (isPile(box.kind)) {
      for (const section of steps(PILE_SECTIONS[box.kind], fromBottom)) {
        const pile = steps(box.perSection, false)
          .map((i) => start + section * box.perSection + i + 1)
          .filter((p) => !off.has(p));
        const share = Math.min(left, pile.length);
        for (let i = share - 1; i >= 0; i--) filled.push(pile[i]);
        for (let i = share; i < pile.length; i++) empty.push(pile[i]);
        left -= share;
      }
    } else {
      for (const row of steps(box.rows, fromBottom)) {
        for (const col of steps(box.cols, fromRight)) {
          const p = start + row * box.cols + col + 1;
          if (off.has(p)) continue;
          if (left > 0) { filled.push(p); left -= 1; } else empty.push(p);
        }
      }
    }
  }
  return [...filled, ...empty];
}

/**
 * Whether a rack's slots were given new numbers after `when`: an edit of a
 * wall renumbers every box after the one that changed (Rack.renumberedAt,
 * set by PUT /api/racks/:id). A slot number remembered before that, in a
 * deleted bottle's snapshot or an MCP undo row, no longer names the place it
 * was taken from. Callers: bottleOps.restoreDeletedBottle and
 * mcp/structuralUndo (mcp/revert asks the database the same). False when
 * either time is unknown.
 */
function renumberedSince(rack, when) {
  const at = rack && rack.renumberedAt ? new Date(rack.renumberedAt).getTime() : NaN;
  const since = when ? new Date(when).getTime() : NaN;
  return Number.isFinite(at) && Number.isFinite(since) && at > since;
}

// What a box is stored with (models/Rack wallBoxSchema), its _id apart.
const BOX_FIELDS = ['x', 'y', 'w', 'h', 'kind', 'perSection', 'rows', 'cols'];

/**
 * The shape of a rack as an import states it, made safe to store. An import
 * builds the rack document itself, so nothing else holds its boxes to the
 * rules a request is held to. A wall's boxes are reduced to their own fields
 * (a file's box ids are not carried: each stored box gets a new one) and
 * checked with validateWallConfig; a wall that fails comes back as a plain
 * grid, as a rack of an unknown type does. `boxes` on any other rack is
 * dropped. Caller: services/cellarImport.createRacks (a bottle-file import
 * cannot state a wall at all: utils/rackImport.sanitizeRackConfigs).
 * Returns { type, typeConfig }.
 */
function importedRackShape(type, rows, cols, typeConfig) {
  const rest = typeConfig && typeof typeConfig === 'object' ? { ...typeConfig } : undefined;
  if (rest) delete rest.boxes;
  if (type !== 'wall') return { type, typeConfig: rest };
  const stated = typeConfig && typeof typeConfig === 'object' ? typeConfig.boxes : null;
  if (Array.isArray(stated) && stated.length <= rows * cols) {
    const boxes = stated.map((b) => (b && typeof b === 'object'
      ? Object.fromEntries(BOX_FIELDS.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, b[k]]))
      : b));
    if (validateWallConfig({ boxes }, 'wall', rows, cols, false) === null) return { type: 'wall', typeConfig: { boxes } };
  }
  return { type: 'grid', typeConfig: rest };
}

// A slot's place inside its box after the box changed size: the same pile and
// the same count from the bottom, or the same row and column. -1 when the
// smaller box no longer has that place.
function sameSlot(kind, from, to, index) {
  if (isPile(kind)) {
    const section = Math.floor(index / from.perSection);
    const i = index % from.perSection;
    return i < to.perSection ? section * to.perSection + i : -1;
  }
  const row = Math.floor(index / from.cols);
  const col = index % from.cols;
  return row < to.rows && col < to.cols ? row * to.cols + col : -1;
}

/**
 * Plan an edit of a wall so that every bottle stays in its box. Boxes are
 * followed by their _id: a box that keeps its id keeps its bottles, wherever
 * it moves and whatever happens to the boxes around it.
 *
 * `bottles` are the positions holding a bottle, `marked` the other numbered
 * positions (switched-off slots, zone members). A bottle that the edit would
 * leave without a place refuses the edit; a marked position without a place
 * is simply dropped.
 *
 * Called by the rack-update route (routes/racks.js) for a wall that stays a
 * wall. Returns { error: string } or { move: Map<old, new>, dropped: Set<old> }.
 */
function planWallEdit(before, after, { bottles = [], marked = [] } = {}) {
  const from = wallRanges(before.rows, before.cols, before.typeConfig);
  const to = new Map(wallRanges(after.rows, after.cols, after.typeConfig).filter((r) => r.id).map((r) => [r.id, r]));

  // Returns the new position, or the reason there is none.
  const place = (position) => {
    const old = from.find((r) => position > r.start && position <= r.start + r.capacity);
    if (!old) return { why: 'gone', label: '?' };
    const now = old.id ? to.get(old.id) : null;
    if (!now) return { why: 'removed', label: old.label };
    if (now.box.kind !== old.box.kind) return { why: 'changed', label: old.label };
    const index = sameSlot(old.box.kind, old.box, now.box, position - old.start - 1);
    if (index < 0) return { why: 'smaller', label: old.label };
    return { to: now.start + index + 1 };
  };

  const move = new Map();
  const dropped = new Set();
  const stuck = new Map(); // label → { why, count }
  for (const position of bottles) {
    const p = place(position);
    if (p.to) { move.set(position, p.to); continue; }
    const key = `${p.label}:${p.why}`;
    stuck.set(key, { ...p, count: (stuck.get(key)?.count || 0) + 1 });
  }
  if (stuck.size > 0) {
    const reason = {
      removed: 'would be removed',
      changed: 'would get another content',
      smaller: 'would no longer have the place of',
      gone: 'no longer exists for',
    };
    const parts = [...stuck.values()].map((s) => (s.why === 'smaller' || s.why === 'gone'
      ? `box ${s.label} ${reason[s.why]} ${s.count} bottle(s) in it`
      : `box ${s.label} holds ${s.count} bottle(s) and ${reason[s.why]}`));
    return { error: `Cannot change the wall: ${parts.join('; ')}. Move those bottles out first.` };
  }
  for (const position of marked) {
    if (move.has(position)) continue;
    const p = place(position);
    if (p.to) move.set(position, p.to); else dropped.add(position);
  }
  return { move, dropped };
}

module.exports = {
  BOX_KINDS, PILE_SECTIONS, SECTION_NAMES, WALL_MAX_PER_SECTION, WALL_MAX_BOX_DIM, WALL_MAX_SLOTS,
  boxCapacity, wallBoxes, wallTotalSlots, wallRanges, boxLabel, wallPlace, wallPlacer,
  validateWallConfig, importedRackShape, planWallEdit, wallNumbering, wallFillOrder, renumberedSince,
};
