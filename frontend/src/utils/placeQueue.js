// Post-add placing queue (issue #1055): the bottles just added arrive at the
// rack view as a queue of ids; each tap on a free slot places the next one,
// and "auto-place remaining" fills first-free slots for whoever does not
// care about exact positions. Pure helpers — the page owns the state and the
// slot endpoint calls.
import { getTotalSlots, getModularTotalSlots } from './rackLayouts';

/** Total slot count of a rack, modular or plain. */
export function rackTotalSlots(rack) {
  if (!rack) return 0;
  return rack.isModular && rack.modules?.length > 0
    ? getModularTotalSlots(rack.modules)
    : getTotalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig);
}

/**
 * Free, enabled positions of a rack in position order, optionally starting
 * from a given position (mirrors the case-placement rule in CellarRacks).
 */
export function freePositions(rack, { from = 1 } = {}) {
  const total = rackTotalSlots(rack);
  const occupied = new Set((rack?.slots || []).map((s) => s.position));
  const disabled = new Set(rack?.disabledPositions || []);
  const out = [];
  for (let p = Math.max(1, from); p <= total; p++) {
    if (!occupied.has(p) && !disabled.has(p)) out.push(p);
  }
  return out;
}

/**
 * Plan "auto-place remaining": pair each queued bottle with the next free
 * position. Fewer free slots than bottles → place what fits and report the
 * rest as still unplaced (the add itself never fails on placement).
 */
export function planAutoPlace(rack, bottleIds) {
  const free = freePositions(rack);
  const pairs = [];
  for (let i = 0; i < bottleIds.length && i < free.length; i++) {
    pairs.push({ position: free[i], bottleId: bottleIds[i] });
  }
  return { pairs, leftover: bottleIds.slice(pairs.length) };
}

/** Parse the router state the add flow hands over; anything odd → empty queue. */
export function readPlaceQueue(state) {
  const ids = state && Array.isArray(state.placeQueue) ? state.placeQueue : [];
  return ids.filter((id) => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id));
}

/**
 * The queue minus every bottle some loaded rack already holds. Router state
 * survives Back/reload, and placing an already-placed bottle again would MOVE
 * it (the slot endpoint has move semantics) — so a re-entered queue must not
 * contain them (audit 2026-09-14).
 */
export function withoutPlaced(ids, racks) {
  const placed = new Set();
  for (const r of racks || []) {
    for (const s of r?.slots || []) {
      const b = s.bottle && typeof s.bottle === 'object' ? s.bottle._id : s.bottle;
      if (b) placed.add(String(b));
    }
  }
  return (ids || []).filter((id) => !placed.has(String(id)));
}
