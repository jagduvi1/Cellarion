/**
 * Auto-arrange — client-side helpers only. The DECISION ENGINE (comparators,
 * target assignment) lives on the SERVER (backend/src/utils/rackArrange.js +
 * rackOps.applyArrangement) and is shared with the MCP auto_arrange tool, so
 * the web app and an AI caller can never drift: the modal calls
 * POST /api/racks/:id/arrange/preview and .../apply (see api/racks.js).
 *
 * What stays client-side:
 *  - fill-corner geometry (buildFillOrder) — where the "first" slot is depends
 *    on how the physical rack is grabbed; the layout engine gives us real
 *    coordinates, and the resulting positionOrder is sent WITH the preview
 *    request so the server plans in that priority order;
 *  - the last-applied record (localStorage, 7 days) — the user's guide for
 *    physically re-shelving, plus what undo needs: undo is simply the apply
 *    endpoint called with target/before swapped.
 */

import { computeLayout, computeModularLayout } from './rackLayouts';

export const FILL_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

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
 * plan per rack in localStorage for a week. Undo calls the apply endpoint
 * with { target: record.before, before: record.after } — the server enforces
 * that the rack still holds EXACTLY the applied layout, so undo is only
 * offered (canUndoArrange) while that is true.
 * ------------------------------------------------------------------------- */

export const ARRANGE_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const recordKey = (rackId) => `cellarion:arrange:last:${rackId}`;
const idOf = (b) => (b?._id || b || '').toString();

/**
 * Build a slim, serializable record of an applied plan from the server's
 * preview payload ({ before, target, changes } — see the arrange endpoints).
 */
export function buildArrangeRecord({ before, target, changes, strategy }, appliedAt = Date.now()) {
  return {
    strategy,
    appliedAt,
    before,          // [{ position, bottleId }] — what undo restores
    after: target,   // [{ position, bottleId }] — what apply produced
    changes: (changes || []).map(c => ({
      from: c.from,
      to: c.to,
      bottleId: c.bottleId,
      name: c.name || '',
      vintage: c.vintage || '',
    })),
  };
}

/**
 * Undo restores the full before-assignment, and the server refuses unless the
 * rack still holds EXACTLY the applied layout — so undo is offered while the
 * current occupancy equals record.after.
 */
export function canUndoArrange(record, slots) {
  if (!record?.after?.length || !record?.before?.length) return false;
  const current = (slots || [])
    .filter(s => s.bottle)
    .map(s => ({ position: s.position, bottleId: idOf(s.bottle) }))
    .sort((a, b) => a.position - b.position);
  const after = [...record.after].sort((a, b) => a.position - b.position);
  return current.length === after.length &&
    current.every((s, i) => s.position === after[i].position && s.bottleId === String(after[i].bottleId));
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
    // Records from the pre-server-engine format (steps-based, no before/after)
    // cannot drive the new undo — drop them rather than misbehave.
    if (!Array.isArray(record.before) || !Array.isArray(record.after)) {
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
