/**
 * Offline writes (#1355) — the pure part. Recognises the writes that may be
 * made offline, turns one into a queued operation carrying what the user saw
 * (the server's preconditions), applies it to the device's snapshot the way the
 * server will, and shapes the response the page expects.
 *
 * Queueable, owner/editor only:
 *   consume   POST   /api/bottles/:id/consume          (+ ifActive, consumedAt)
 *   open      POST   /api/bottles/:id/open             (+ openedAt)
 *   edit      PUT    /api/bottles/:id                  notes / rating / ratingScale only (+ ifUnchanged)
 *   place     PUT    /api/racks/:id/slots/:pos         (+ expectOccupant)
 *   clear     DELETE /api/racks/:id/slots/:pos         (+ ?expect=)
 *   move      POST   /api/racks/:id/slots/:pos/move    (+ expectFrom / expectTo)
 * Everything else is not queueable and fails offline as before.
 */
import { indexSnapshot } from './offlineData';

const ID = '[a-f0-9]{24}';
const EDITABLE = ['notes', 'rating', 'ratingScale'];

/** The shape of a queueable request, from its URL and method alone. */
export function queueableKind(url, method) {
  let p;
  try { p = new URL(String(url), 'http://offline.invalid').pathname; } catch { return null; }
  const m = String(method || 'GET').toUpperCase();
  if (m === 'POST' && new RegExp(`^/api/bottles/${ID}/consume$`).test(p)) return 'consume';
  if (m === 'POST' && new RegExp(`^/api/bottles/${ID}/open$`).test(p)) return 'open';
  if (m === 'PUT' && new RegExp(`^/api/bottles/${ID}$`).test(p)) return 'edit';
  if (m === 'PUT' && new RegExp(`^/api/racks/${ID}/slots/\\d+$`).test(p)) return 'place';
  if (m === 'DELETE' && new RegExp(`^/api/racks/${ID}/slots/\\d+$`).test(p)) return 'clear';
  if (m === 'POST' && new RegExp(`^/api/racks/${ID}/slots/\\d+/move$`).test(p)) return 'move';
  return null;
}

const norm = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
};
const sameVal = (a, b) => {
  const x = norm(a); const y = norm(b);
  if (x && typeof x === 'object') return JSON.stringify(x) === JSON.stringify(y);
  return x === y;
};

function wineLabel(b) {
  const w = b && typeof b.wineDefinition === 'object' ? b.wineDefinition : null;
  const name = w?.name || b?.pendingWineRequest?.wineName || '';
  return [name, b?.vintage && b.vintage !== 'NV' ? b.vintage : null].filter(Boolean).join(' ');
}

function occupant(rack, position) {
  const s = (rack.slots || []).find((x) => x.position === position);
  return s && s.bottle ? String(s.bottle) : null;
}

/**
 * Build the queued operation for one request, or null when it is not
 * queueable offline (wrong shape, unknown bottle/rack, viewer role, or an edit
 * touching more than notes/rating). `now` is the moment the user acted.
 */
export function buildOp({ url, method, body, idx, id, userId, now = new Date() }) {
  const kind = queueableKind(url, method);
  if (!kind || !idx) return null;
  const path = new URL(String(url), 'http://offline.invalid').pathname;
  const seg = path.split('/');
  const payload = body && typeof body === 'object' ? body : {};
  const base = { id, userId, kind, createdAt: now.toISOString(), status: 'pending' };
  const canEdit = (cellarId) => ['owner', 'editor'].includes(idx.cellarById.get(String(cellarId))?.userRole);

  if (kind === 'consume' || kind === 'open' || kind === 'edit') {
    const bottleId = seg[3];
    const bottle = idx.bottleById.get(bottleId);
    if (!bottle || !canEdit(bottle.cellar)) return null;
    const label = { wine: wineLabel(bottle) };
    if (kind === 'consume') {
      // A few seconds back: "not in the future" on the server must hold even
      // for a phone clock slightly ahead.
      const at = new Date(now.getTime() - 5000).toISOString();
      return { ...base, bottleId, cellarId: String(bottle.cellar), label, method: 'POST', url: path,
        body: { ...payload, consumedAt: payload.consumedAt || at, ifActive: true } };
    }
    if (kind === 'open') {
      const at = new Date(now.getTime() - 5000).toISOString();
      return { ...base, bottleId, cellarId: String(bottle.cellar), label, method: 'POST', url: path,
        body: { ...payload, openedAt: payload.openedAt || at } };
    }
    // edit: only a change to notes / rating / ratingScale is queueable. The
    // edit form sends the whole form, so compare it with what is on the device.
    const changed = Object.keys(payload).filter((k) => !sameVal(payload[k], bottle[k]));
    if (!changed.length || changed.some((k) => !EDITABLE.includes(k))) return null;
    const send = {};
    const ifUnchanged = {};
    for (const k of EDITABLE) {
      if (!changed.includes(k) && !(k === 'rating' && changed.includes('ratingScale'))) continue;
      send[k] = payload[k] ?? null;
      ifUnchanged[k] = bottle[k] ?? null;
    }
    return { ...base, bottleId, cellarId: String(bottle.cellar), label: { ...label, fields: Object.keys(send) },
      method: 'PUT', url: path, body: { ...send, ifUnchanged } };
  }

  const rackId = seg[3];
  const position = parseInt(seg[5], 10);
  const rack = [...idx.racksByCellar.values()].flat().find((r) => String(r._id) === rackId);
  if (!rack || !canEdit(rack.cellar)) return null;
  const rackBase = { ...base, rackId, cellarId: String(rack.cellar), position };
  if (kind === 'place') {
    const bottleId = String(payload.bottleId || '');
    const bottle = idx.bottleById.get(bottleId);
    if (!bottle) return null;
    return { ...rackBase, bottleId, label: { wine: wineLabel(bottle), rack: rack.name, position },
      method: 'PUT', url: path, body: { bottleId, expectOccupant: occupant(rack, position) } };
  }
  if (kind === 'clear') {
    const was = occupant(rack, position);
    if (!was) return null;
    return { ...rackBase, bottleId: was, label: { wine: wineLabel(idx.bottleById.get(was)), rack: rack.name, position },
      method: 'DELETE', url: `${path}?expect=${was}`, body: null };
  }
  // move
  const to = parseInt(payload.toPosition, 10);
  const from = occupant(rack, position);
  if (!from || Number.isNaN(to)) return null;
  return { ...rackBase, bottleId: from, toPosition: to,
    label: { wine: wineLabel(idx.bottleById.get(from)), rack: rack.name, position, toPosition: to },
    method: 'POST', url: path, body: { toPosition: to, expectFrom: from, expectTo: occupant(rack, to) } };
}

/** Apply a queued op to a raw snapshot the way the server will. Returns a new snapshot. */
export function applyOp(snapshot, op) {
  const s = {
    ...snapshot,
    bottles: [...(snapshot.bottles || [])],
    racks: (snapshot.racks || []).map((r) => ({ ...r, slots: [...(r.slots || [])] })),
  };
  const bi = s.bottles.findIndex((b) => String(b._id) === op.bottleId);
  const unrack = (bottleId) => {
    for (const r of s.racks) r.slots = r.slots.filter((x) => String(x.bottle) !== bottleId);
  };
  switch (op.kind) {
    case 'consume':
      if (bi >= 0) s.bottles.splice(bi, 1); // the snapshot only holds bottles still in the cellar
      unrack(op.bottleId);
      break;
    case 'open':
      if (bi >= 0) s.bottles[bi] = { ...s.bottles[bi], openedAt: op.body.openedAt, preservationMethod: op.body.preservationMethod, pours: [] };
      break;
    case 'edit': {
      if (bi < 0) break;
      const { ifUnchanged, ...fields } = op.body;
      s.bottles[bi] = { ...s.bottles[bi], ...fields };
      break;
    }
    case 'place': {
      const r = s.racks.find((x) => String(x._id) === op.rackId);
      if (!r) break;
      unrack(op.bottleId);
      r.slots = r.slots.filter((x) => x.position !== op.position);
      r.slots.push({ position: op.position, bottle: op.bottleId });
      break;
    }
    case 'clear': {
      const r = s.racks.find((x) => String(x._id) === op.rackId);
      if (r) r.slots = r.slots.filter((x) => x.position !== op.position);
      break;
    }
    case 'move': {
      const r = s.racks.find((x) => String(x._id) === op.rackId);
      if (!r) break;
      r.slots = r.slots.map((x) => {
        if (x.position === op.position) return { ...x, position: op.toPosition };
        if (x.position === op.toPosition) return { ...x, position: op.position }; // swap, as the server does
        return x;
      });
      break;
    }
    default:
  }
  return s;
}

/** Apply every still-pending op for this snapshot's user, in order. */
export function applyPending(snapshot, ops) {
  return (ops || [])
    .filter((op) => op.status === 'pending' && String(op.userId) === String(snapshot.userId))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .reduce(applyOp, snapshot);
}

/**
 * The body the page expects back for an op, from the snapshot with the op
 * already applied (`idx` = indexSnapshot of that snapshot; `before` = the
 * index before, for a consumed bottle that is no longer in the snapshot).
 */
export function responseFor(op, idx, before) {
  if (op.kind === 'consume') {
    const b = before?.bottleById.get(op.bottleId) || { _id: op.bottleId };
    return { bottle: { ...b, status: op.body.reason || 'drank', consumedAt: op.body.consumedAt, consumedReason: op.body.reason || 'drank' } };
  }
  if (op.kind === 'open' || op.kind === 'edit') {
    return { bottle: idx.bottleById.get(op.bottleId) || { _id: op.bottleId } };
  }
  const r = [...idx.racksByCellar.values()].flat().find((x) => String(x._id) === op.rackId);
  if (!r) return { rack: null };
  return {
    rack: { ...r, slots: (r.slots || []).map((x) => ({ ...x, bottle: x.bottle ? idx.bottleById.get(String(x.bottle)) || null : null })) },
  };
}

export { indexSnapshot };
