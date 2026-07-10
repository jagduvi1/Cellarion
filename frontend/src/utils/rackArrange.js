/**
 * Auto-arrange engine — proposes a better ordering of a rack's bottles and
 * the operation sequence to reach it through the atomic move/swap endpoint.
 *
 * Slot positions are treated in ascending order: position 1 is the top-left
 * of every rack type, so "first" positions are the most visible/accessible
 * ones. Disabled positions are never used.
 */

import { computeLayout, computeModularLayout } from './rackLayouts';

export const ARRANGE_STRATEGIES = ['maturity', 'type', 'vintage'];

export const FILL_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

// Urgency first: what must be drunk soon belongs in the first slots.
const MATURITY_RANK = {
  declining: 0,
  late: 1,
  peak: 2,
  early: 3,
  'not-ready': 4,
};
const NO_MATURITY_RANK = 5;

const TYPE_ORDER = {
  red: 0,
  white: 1,
  'rosé': 2,
  sparkling: 3,
  dessert: 4,
  fortified: 5,
};
const NO_TYPE_ORDER = 6;

function maturityRank(bottle) {
  const r = MATURITY_RANK[bottle?.maturityStatus];
  return r === undefined ? NO_MATURITY_RANK : r;
}

function typeRank(bottle) {
  const r = TYPE_ORDER[bottle?.wineDefinition?.type];
  return r === undefined ? NO_TYPE_ORDER : r;
}

// NV / unparseable vintages sort after real years (they have no aging urgency).
function vintageRank(bottle) {
  const y = Number(bottle?.vintage);
  return Number.isInteger(y) ? y : Infinity;
}

function nameKey(bottle) {
  return (bottle?.wineDefinition?.name || '').toLowerCase();
}

const COMPARATORS = {
  maturity: (a, b) =>
    maturityRank(a) - maturityRank(b) ||
    typeRank(a) - typeRank(b) ||
    vintageRank(a) - vintageRank(b) ||
    nameKey(a).localeCompare(nameKey(b)),
  type: (a, b) =>
    typeRank(a) - typeRank(b) ||
    maturityRank(a) - maturityRank(b) ||
    vintageRank(a) - vintageRank(b) ||
    nameKey(a).localeCompare(nameKey(b)),
  vintage: (a, b) =>
    vintageRank(a) - vintageRank(b) ||
    nameKey(a).localeCompare(nameKey(b)),
};

/**
 * Build an arrangement plan for one rack.
 *
 * @param {Array<{position: number, bottle: object}>} entries  occupied slots
 * @param {number}   maxPosition        rack capacity (getMaxPosition equivalent)
 * @param {number[]} disabledPositions
 * @param {string}   strategy           'maturity' | 'type' | 'vintage'
 * @param {number[]} [positionOrder]    fill-priority order of all positions
 *                                      (see buildFillOrder); defaults to ascending
 * @returns {{
 *   changes: Array<{ bottle, from, to }>,   // human list: who ends up where
 *   steps:   Array<{ from, to, swap }>,     // op sequence for the move endpoint
 * }}
 */
export function buildArrangePlan(entries, maxPosition, disabledPositions, strategy, positionOrder) {
  const disabled = new Set(disabledPositions || []);
  const order = positionOrder && positionOrder.length > 0
    ? positionOrder
    : Array.from({ length: maxPosition }, (_, i) => i + 1);
  const usable = order.filter(p => !disabled.has(p));

  const occupied = (entries || []).filter(e => e.bottle);
  const sorted = [...occupied].sort((a, b) =>
    (COMPARATORS[strategy] || COMPARATORS.maturity)(a.bottle, b.bottle)
  );

  // Desired: sorted bottles fill the first usable positions.
  const idOf = (b) => (b?._id || b || '').toString();
  const desired = new Map(); // position -> bottleId
  sorted.forEach((e, i) => desired.set(usable[i], idOf(e.bottle)));

  const bottleById = new Map(occupied.map(e => [idOf(e.bottle), e.bottle]));
  const state = new Map(occupied.map(e => [e.position, idOf(e.bottle)])); // position -> bottleId

  // Human-facing change list: every bottle whose slot differs.
  const currentPosOf = new Map(occupied.map(e => [idOf(e.bottle), e.position]));
  const changes = [];
  for (const [pos, bid] of desired) {
    const from = currentPosOf.get(bid);
    if (from !== pos) changes.push({ bottle: bottleById.get(bid), from, to: pos });
  }
  changes.sort((a, b) => a.to - b.to);

  // Op sequence: settle each desired position in order. Every op is a legal
  // single move/swap against POST /slots/:from/move, and applying them in
  // order provably reaches the desired state (each iteration fixes one
  // position and never disturbs already-settled ones).
  const steps = [];
  const posOf = new Map(); // bottleId -> position (live)
  for (const [pos, bid] of state) posOf.set(bid, pos);

  for (const [target, wantId] of desired) {
    const curId = state.get(target);
    if (curId === wantId) continue;
    const src = posOf.get(wantId);
    steps.push({ from: src, to: target, swap: curId !== undefined });
    // apply to live state
    if (curId !== undefined) {
      state.set(src, curId);
      posOf.set(curId, src);
    } else {
      state.delete(src);
    }
    state.set(target, wantId);
    posOf.set(wantId, target);
  }

  return { changes, steps };
}

/* ---------------------------------------------------------------------------
 * Fill order — where the "first" slot is.
 *
 * Position numbers ascend from the top-left in every rack type, but the most
 * accessible corner of a physical rack varies (a floor rack is grabbed from
 * the top, an over-fridge rack from the bottom). The layout engine gives us
 * real coordinates for every slot, so the fill priority is derived
 * geometrically and works for any rack type, including modular ones.
 * ------------------------------------------------------------------------- */

/**
 * Priority-ordered list of ALL slot positions for a rack, starting at the
 * given corner. Slots sharing a visual row (identical y) order by x.
 */
export function buildFillOrder(rack, corner = 'top-left') {
  const layout = rack.isModular && rack.modules?.length > 0
    ? computeModularLayout(rack.modules)
    : computeLayout(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
  const fromBottom = corner.startsWith('bottom');
  const fromRight = corner.endsWith('right');

  // Band by y so the sort is transitive: same-row slots share an exact cy.
  const bands = [...new Set(layout.slots.map(s => Math.round(s.cy)))].sort((a, b) => a - b);
  const bandOf = new Map(bands.map((v, i) => [v, i]));

  return [...layout.slots]
    .sort((a, b) => {
      const ra = bandOf.get(Math.round(a.cy));
      const rb = bandOf.get(Math.round(b.cy));
      if (ra !== rb) return fromBottom ? rb - ra : ra - rb;
      return fromRight ? b.cx - a.cx : a.cx - b.cx;
    })
    .map(s => s.position);
}

/* ---------------------------------------------------------------------------
 * Last-applied plan: persistence + undo.
 *
 * The post-apply change list is the user's guide for physically rearranging
 * the bottles, so it must survive the modal closing. We keep the last applied
 * plan per rack in localStorage for a week, and store enough state to undo it:
 * replaying the steps in reverse order (from/to flipped) exactly restores the
 * original layout — but only from the exact state the plan produced, so the
 * record also snapshots what every touched position held after the apply.
 * ------------------------------------------------------------------------- */

export const ARRANGE_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const recordKey = (rackId) => `cellarion:arrange:last:${rackId}`;
const idOf = (b) => (b?._id || b || '').toString();

/**
 * Build a slim, serializable record of an applied plan.
 * `entries` must be the occupied slots as they were BEFORE the plan ran.
 */
export function buildArrangeRecord(entries, plan, strategy, appliedAt = Date.now()) {
  // Replay the steps to learn the post-apply contents of every touched
  // position — that snapshot is what makes undo safe to offer later.
  const state = new Map(
    (entries || []).filter(e => e.bottle).map(e => [e.position, idOf(e.bottle)])
  );
  for (const { from, to } of plan.steps) {
    const moving = state.get(from);
    const displaced = state.get(to);
    if (displaced !== undefined) state.set(from, displaced);
    else state.delete(from);
    state.set(to, moving);
  }
  const touchedPositions = [...new Set(plan.steps.flatMap(s => [s.from, s.to]))]
    .sort((a, b) => a - b);

  return {
    strategy,
    appliedAt,
    steps: plan.steps.map(({ from, to, swap }) => ({ from, to, swap })),
    changes: plan.changes.map(c => ({
      from: c.from,
      to: c.to,
      bottleId: idOf(c.bottle),
      name: c.bottle?.wineDefinition?.name || '',
      vintage: c.bottle?.vintage || '',
    })),
    touched: touchedPositions.map(p => ({ position: p, bottleId: state.get(p) ?? null })),
  };
}

/** Reversed op sequence: undoing the last step first walks back to the start. */
export function buildUndoSteps(steps) {
  return [...steps].reverse().map(({ from, to, swap }) => ({ from: to, to: from, swap }));
}

/**
 * Undo is only exact from the state the plan left behind. True when every
 * touched position still holds exactly what the record says it should.
 */
export function canUndoArrange(record, slots) {
  if (!record?.touched?.length) return false;
  const current = new Map(
    (slots || []).filter(s => s.bottle).map(s => [s.position, idOf(s.bottle)])
  );
  return record.touched.every(t => (current.get(t.position) ?? null) === t.bottleId);
}

export function saveArrangeRecord(rackId, record) {
  try {
    localStorage.setItem(recordKey(rackId), JSON.stringify(record));
  } catch { /* storage full or unavailable — the feature degrades gracefully */ }
}

export function loadArrangeRecord(rackId, now = Date.now()) {
  try {
    const raw = localStorage.getItem(recordKey(rackId));
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!record?.appliedAt || now - record.appliedAt > ARRANGE_RECORD_TTL_MS) {
      localStorage.removeItem(recordKey(rackId));
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function clearArrangeRecord(rackId) {
  try {
    localStorage.removeItem(recordKey(rackId));
  } catch { /* ignore */ }
}

/* The preferred fill corner reflects where the physical rack sits (floor,
 * counter, above the fridge…), so it is remembered per rack — no TTL. */
const cornerKey = (rackId) => `cellarion:arrange:corner:${rackId}`;

export function loadArrangeCorner(rackId) {
  try {
    const v = localStorage.getItem(cornerKey(rackId));
    return FILL_CORNERS.includes(v) ? v : 'top-left';
  } catch {
    return 'top-left';
  }
}

export function saveArrangeCorner(rackId, corner) {
  try {
    localStorage.setItem(cornerKey(rackId), corner);
  } catch { /* ignore */ }
}
