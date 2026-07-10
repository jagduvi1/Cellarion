/**
 * Auto-arrange engine — proposes a better ordering of a rack's bottles and
 * the operation sequence to reach it through the atomic move/swap endpoint.
 *
 * Slot positions are treated in ascending order: position 1 is the top-left
 * of every rack type, so "first" positions are the most visible/accessible
 * ones. Disabled positions are never used.
 */

export const ARRANGE_STRATEGIES = ['maturity', 'type', 'vintage'];

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
 * @returns {{
 *   changes: Array<{ bottle, from, to }>,   // human list: who ends up where
 *   steps:   Array<{ from, to, swap }>,     // op sequence for the move endpoint
 * }}
 */
export function buildArrangePlan(entries, maxPosition, disabledPositions, strategy) {
  const disabled = new Set(disabledPositions || []);
  const usable = [];
  for (let p = 1; p <= maxPosition; p++) {
    if (!disabled.has(p)) usable.push(p);
  }

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
