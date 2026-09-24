/**
 * Offline reads (#1355): answer the app's own GET requests from the snapshot
 * kept on the device (GET /api/offline/snapshot), in the SAME response shapes
 * the server uses, so pages need no offline code of their own.
 *
 * Covered: the cellar list, a cellar's bottles (search / common filters /
 * sort / grouping / paging), its racks and room layout, and a bottle. Anything
 * else returns null and the request fails as it would have without offline
 * mode. Registry search, stats, history, AI — out of scope by design.
 *
 * Pure: no storage, no network. utils/offlineSnapshot.js feeds it.
 */

const MATURITY_RANK = { declining: 0, late: 1, peak: 2, early: 3, 'not-ready': 4 };

const idOf = (v) => (v && typeof v === 'object' ? String(v._id) : v != null ? String(v) : null);

/** Index a snapshot once; the result is reused for every request. */
export function indexSnapshot(snapshot) {
  const wines = snapshot.wines || {};
  const bottles = (snapshot.bottles || []).map((b) => ({
    ...b,
    wineDefinition: b.wineDefinition ? wines[b.wineDefinition] || b.wineDefinition : null,
  }));
  const bottleById = new Map(bottles.map((b) => [String(b._id), b]));
  const cellarById = new Map((snapshot.cellars || []).map((c) => [String(c._id), c]));
  const racksByCellar = new Map();
  const placement = new Map(); // bottle id → { rackId, rackName, position, inRoom }
  for (const r of snapshot.racks || []) {
    const cid = idOf(r.cellar);
    if (!racksByCellar.has(cid)) racksByCellar.set(cid, []);
    racksByCellar.get(cid).push(r);
    for (const s of r.slots || []) {
      if (s.bottle) placement.set(String(s.bottle), { rackId: r._id, rackName: r.name, position: s.position, inRoom: false });
    }
  }
  return { snapshot, bottles, bottleById, cellarById, racksByCellar, placement };
}

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function listParam(params, key) {
  const v = params.get(key);
  return v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function isReserved(b) {
  return !!(b.reservedFor || b.reservedUntil);
}

function haystack(b) {
  const w = b.wineDefinition && typeof b.wineDefinition === 'object' ? b.wineDefinition : {};
  return norm([
    w.name, w.producer, w.appellation, w.region?.name, w.country?.name,
    ...(w.grapes || []).map((g) => g?.name),
    b.pendingWineRequest?.wineName, b.pendingWineRequest?.producer,
    b.vintage, b.location, b.notes,
  ].filter(Boolean).join(' '));
}

function filterBottles(idx, cellarId, params) {
  const wineOf = (b) => (b.wineDefinition && typeof b.wineDefinition === 'object' ? b.wineDefinition : {});
  let list = idx.bottles.filter((b) => idOf(b.cellar) === cellarId);

  const search = norm(params.get('search')).trim();
  if (search) {
    const words = search.split(/\s+/);
    list = list.filter((b) => { const h = haystack(b); return words.every((w) => h.includes(w)); });
  }
  const types = listParam(params, 'type');
  if (types.length) list = list.filter((b) => types.includes(wineOf(b).type));
  const vintages = listParam(params, 'vintage');
  if (vintages.length) list = list.filter((b) => vintages.includes(String(b.vintage || 'NV')));
  const countries = listParam(params, 'country');
  if (countries.length) list = list.filter((b) => countries.includes(idOf(wineOf(b).country)));
  const regions = listParam(params, 'region');
  if (regions.length) list = list.filter((b) => regions.includes(idOf(wineOf(b).region)));
  const grapes = listParam(params, 'grapes');
  if (grapes.length) list = list.filter((b) => (wineOf(b).grapes || []).some((g) => grapes.includes(idOf(g))));
  const appellation = params.get('appellation');
  if (appellation) list = list.filter((b) => norm(wineOf(b).appellation) === norm(appellation));
  const maturity = listParam(params, 'maturity');
  if (maturity.length) list = list.filter((b) => maturity.includes(b.maturityStatus || 'unknown'));
  if (params.get('reserved') === '1' || params.get('reserved') === 'true') list = list.filter(isReserved);

  const exclude = new Set(listParam(params, 'exclude'));
  if (params.get('excludePlaced') === '1' || params.get('excludePlaced') === 'true') {
    for (const id of idx.placement.keys()) exclude.add(id);
  }
  if (exclude.size) list = list.filter((b) => !exclude.has(String(b._id)));

  const rack = params.get('rack');
  const rackGroup = params.get('rackGroup');
  if (rack || rackGroup) {
    const racks = (idx.racksByCellar.get(cellarId) || [])
      .filter((r) => (rack ? String(r._id) === rack : String(r.group || '') === rackGroup.trim()));
    const ids = new Set(racks.flatMap((r) => (r.slots || []).map((s) => s.bottle).filter(Boolean).map(String)));
    list = list.filter((b) => ids.has(String(b._id)));
  }
  return list;
}

function sortBottles(list, sort) {
  const s = sort || '-createdAt';
  const dir = s.startsWith('-') ? -1 : 1;
  const field = s.replace(/^-/, '');
  const value = (b) => {
    if (field === 'name') return norm(b.wineDefinition?.name || b.pendingWineRequest?.wineName);
    if (field === 'maturity') return b.maturityStatus != null && b.maturityStatus in MATURITY_RANK ? MATURITY_RANK[b.maturityStatus] : 5;
    if (field === 'vintage') return b.vintage && /^\d+$/.test(b.vintage) ? Number(b.vintage) : null;
    if (field === 'price' || field === 'rating') return typeof b[field] === 'number' ? b[field] : null;
    return b.createdAt || '';
  };
  return [...list].sort((a, b) => {
    const av = value(a); const bv = value(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // missing values last, whichever direction
    if (bv == null) return -1;
    if (av < bv) return -dir;
    if (av > bv) return dir;
    return 0;
  });
}

function groupKey(b) {
  const wineId = b.wineDefinition ? idOf(b.wineDefinition) : `none:${b._id}`;
  return `${wineId}::${b.vintage || 'NV'}::${b.bottleSize || '750ml'}`;
}

function cellarForDetail(cellar) {
  return cellar; // `user` stays populated ({ _id, username }) as GET /api/cellars/:id returns it
}

function cellarForList(cellar) {
  return { ...cellar, user: idOf(cellar.user) }; // GET /api/cellars returns the owner id
}

function cellarDetail(idx, cellarId, params) {
  const cellar = idx.cellarById.get(cellarId);
  if (!cellar) return { status: 404, body: { error: 'Cellar not found' } };
  const limit = Math.min(Math.max(parseInt(params.get('limit'), 10) || 30, 1), 200);
  const skip = Math.max(parseInt(params.get('skip') || params.get('offset'), 10) || 0, 0);
  const grouped = params.get('group') === '1' || params.get('group') === 'true';

  const list = sortBottles(filterBottles(idx, cellarId, params), params.get('sort'));
  let items;
  let total;
  if (grouped) {
    const groups = new Map();
    for (const b of list) {
      const k = groupKey(b);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
    const all = [...groups.entries()].map(([key, bottles]) => ({ key, count: bottles.length, bottles }));
    total = all.length;
    items = all.slice(skip, skip + limit);
  } else {
    total = list.length;
    items = list.slice(skip, skip + limit);
  }
  return {
    status: 200,
    body: { cellar: cellarForDetail(cellar), bottles: { total, count: items.length, limit, skip, grouped, items } },
  };
}

function racksFor(idx, cellarId) {
  if (!idx.cellarById.has(cellarId)) return { status: 404, body: { error: 'Cellar not found' } };
  const racks = (idx.racksByCellar.get(cellarId) || []).map((r) => ({
    ...r,
    slots: (r.slots || []).map((s) => ({ ...s, bottle: s.bottle ? idx.bottleById.get(String(s.bottle)) || null : null })),
  }));
  return { status: 200, body: { racks } };
}

function bottleDetail(idx, bottleId) {
  const bottle = idx.bottleById.get(bottleId);
  if (!bottle) return { status: 404, body: { error: 'Bottle not found' } };
  const cellar = idx.cellarById.get(idOf(bottle.cellar));
  return {
    status: 200,
    body: {
      bottle,
      userRole: cellar?.userRole || 'viewer',
      cellarColor: cellar?.userColor || null,
      pendingImageUrl: bottle.pendingImageUrl || null,
      defaultImageUrl: bottle.defaultImageUrl || null,
      currentRelease: null,
      rackInfo: idx.placement.get(bottleId) || null,
      lotSiblingIds: [],
    },
  };
}

/**
 * The offline answer to one GET, or null when the snapshot cannot answer it.
 * `url` may be absolute or a path; returns { status, body }.
 */
export function answerOffline(idx, url) {
  if (!idx) return null;
  let u;
  try { u = new URL(String(url), 'http://offline.invalid'); } catch { return null; }
  const p = u.pathname.replace(/\/+$/, '');
  const q = u.searchParams;
  let m;
  if (p === '/api/cellars') {
    const cellars = (idx.snapshot.cellars || []).map(cellarForList);
    return { status: 200, body: { count: cellars.length, cellars } };
  }
  if ((m = /^\/api\/cellars\/([a-f0-9]{24})$/.exec(p))) return cellarDetail(idx, m[1], q);
  if (p === '/api/racks' && /^[a-f0-9]{24}$/.test(q.get('cellar') || '')) return racksFor(idx, q.get('cellar'));
  if (p === '/api/cellar-layout' && /^[a-f0-9]{24}$/.test(q.get('cellar') || '')) return { status: 200, body: { layout: null } };
  if ((m = /^\/api\/bottles\/([a-f0-9]{24})$/.exec(p))) return bottleDetail(idx, m[1]);
  return null;
}
