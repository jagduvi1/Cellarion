/**
 * Auto-arrange decision engine (backend) — proposes a better ordering of a
 * rack's bottles. Sorted bottles fill the usable positions in ascending order:
 * position 1 is the top-left of every rack type, so "first" positions are the
 * most visible/accessible ones. Disabled positions are never used.
 *
 * ⚠ KEEP IN SYNC with frontend/src/utils/rackArrange.js — this is the same
 * pure engine (comparators + plan builder) minus the browser-only parts
 * (fill-corner geometry, localStorage persistence). The frontend drives the
 * per-slot move endpoint step by step; the MCP auto_arrange tool applies the
 * target assignment atomically in one rack save instead, so only `changes`
 * (who ends up where) is produced here, not the frontend's op sequence.
 */

const ARRANGE_STRATEGIES = ['maturity', 'type', 'vintage'];

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
 * Build an arrangement for one rack.
 *
 * @param {Array<{position: number, bottle: object}>} entries  occupied slots;
 *   each bottle may carry `maturityStatus`, `wineDefinition.{type,name}`,
 *   `vintage`, `_id`
 * @param {number}   maxPosition        rack capacity (utils/rackGeometry getMaxPosition)
 * @param {number[]} disabledPositions
 * @param {string}   strategy           'maturity' | 'type' | 'vintage'
 * @returns {{
 *   target:  Array<{ position, bottleId }>,     // the full desired assignment
 *   changes: Array<{ bottle, from, to }>,       // bottles whose slot differs
 * }}
 */
function buildArrangePlan(entries, maxPosition, disabledPositions, strategy) {
  const disabled = new Set(disabledPositions || []);
  const usable = Array.from({ length: maxPosition }, (_, i) => i + 1)
    .filter((p) => !disabled.has(p));

  const occupied = (entries || []).filter((e) => e.bottle);
  const sorted = [...occupied].sort((a, b) =>
    (COMPARATORS[strategy] || COMPARATORS.maturity)(a.bottle, b.bottle)
  );

  // Desired: sorted bottles fill the first usable positions.
  const idOf = (b) => (b?._id || b || '').toString();
  const target = sorted.map((e, i) => ({ position: usable[i], bottleId: idOf(e.bottle) }));

  // Human-facing change list: every bottle whose slot differs.
  const bottleById = new Map(occupied.map((e) => [idOf(e.bottle), e.bottle]));
  const currentPosOf = new Map(occupied.map((e) => [idOf(e.bottle), e.position]));
  const changes = [];
  for (const { position, bottleId } of target) {
    const from = currentPosOf.get(bottleId);
    if (from !== position) changes.push({ bottle: bottleById.get(bottleId), from, to: position });
  }
  changes.sort((a, b) => a.to - b.to);

  return { target, changes };
}

module.exports = { ARRANGE_STRATEGIES, COMPARATORS, buildArrangePlan };
