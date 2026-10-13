/**
 * Pick lists — the ONE implementation behind REST /api/pick-lists and the
 * MCP pick-list tools (forum request 2026-10-13: "a pick list … with the rack
 * and bottle position for each wine, so you don't have to open every wine").
 *
 * A list holds references to the user's own bottles; where each one sits is
 * read live when the list is shown (rack, slot, whether the rack is placed
 * in the room view), so a bottle moved since it was added never shows a
 * stale slot. Every change is an atomic update, so two devices ticking at
 * once never overwrite each other.
 *
 * Access: a bottle can go on a list when the user can see its cellar (owner,
 * editor or viewer) and it is in the cellar (status active). When the list is
 * shown, a bottle the user can no longer see — deleted, or its cellar gone or
 * no longer shared — is listed as unavailable, with nothing about it.
 *
 * Returns { error: { status, message } } | { …result } like bottleOps.
 */
const mongoose = require('mongoose');
const PickList = require('../models/PickList');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const { getCellarRole } = require('../utils/cellarAccess');
const { isValidId } = require('../utils/validation');
const { stripHtml } = require('../utils/sanitize');
const { logAudit } = require('./audit');

const { MAX_ITEMS_PER_LIST, MAX_LISTS_PER_USER } = PickList;
const err = (status, message) => ({ error: { status, message } });

function parseName(raw) {
  if (typeof raw !== 'string') return { error: 'A pick list needs a name' };
  const name = stripHtml(raw).trim();
  if (!name) return { error: 'A pick list needs a name' };
  if (name.length > 100) return { error: 'Pick list name too long (max 100 characters)' };
  return { name };
}

/** Valid, unique ids from a client list; { error } when it is not a list of ids. */
function parseBottleIds(raw, { allowEmpty = false } = {}) {
  if (raw === undefined || raw === null) return allowEmpty ? { ids: [] } : { error: 'bottleIds must be a list of bottle ids' };
  if (!Array.isArray(raw)) return { error: 'bottleIds must be a list of bottle ids' };
  if (raw.length > MAX_ITEMS_PER_LIST) return { error: `At most ${MAX_ITEMS_PER_LIST} bottles at a time` };
  const ids = [];
  const seen = new Set();
  for (const id of raw) {
    if (!isValidId(id)) return { error: 'bottleIds must be valid bottle ids' };
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (!ids.length && !allowEmpty) return { error: 'bottleIds must not be empty' };
  return { ids };
}

async function findOwnList(userId, id, { lean = true } = {}) {
  if (!isValidId(id)) return null;
  const q = PickList.findOne({ _id: id, user: userId });
  return lean ? q.lean() : q;
}

/**
 * The bottles among `ids` the user may put on a list: in a cellar they can
 * see, not deleted, still in the cellar. → { ok: Set<string>, skipped: [{ id, reason }] }
 */
async function sortAddable(userId, ids) {
  const bottles = await Bottle.find({ _id: { $in: ids } }).select('cellar status').lean();
  const cellarIds = [...new Set(bottles.map((b) => String(b.cellar)))];
  const cellars = await Cellar.find({ _id: { $in: cellarIds }, deletedAt: null }).select('user members').lean();
  const visible = new Set(cellars.filter((c) => getCellarRole(c, userId)).map((c) => String(c._id)));
  const byId = new Map(bottles.map((b) => [String(b._id), b]));
  const ok = new Set();
  const skipped = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b || !visible.has(String(b.cellar))) skipped.push({ id, reason: 'not_found' });
    else if (b.status !== 'active') skipped.push({ id, reason: 'not_in_cellar' });
    else ok.add(id);
  }
  return { ok, skipped };
}

const summary = (list) => ({
  id: list._id,
  name: list.name,
  count: (list.items || []).length,
  picked: (list.items || []).filter((it) => it.pickedAt).length,
  createdAt: list.createdAt,
  updatedAt: list.updatedAt,
});

async function listPickLists(userId) {
  const lists = await PickList.find({ user: userId }).sort({ updatedAt: -1 }).lean();
  return { lists: lists.map(summary) };
}

async function createPickList(userId, { name, bottleIds } = {}, req) {
  const n = parseName(name);
  if (n.error) return err(400, n.error);
  const parsed = parseBottleIds(bottleIds, { allowEmpty: true });
  if (parsed.error) return err(400, parsed.error);
  if (await PickList.countDocuments({ user: userId }) >= MAX_LISTS_PER_USER) {
    return err(400, `You can keep at most ${MAX_LISTS_PER_USER} pick lists. Delete one you no longer need first.`);
  }
  const { ok, skipped } = parsed.ids.length ? await sortAddable(userId, parsed.ids) : { ok: new Set(), skipped: [] };
  const now = new Date();
  const list = await PickList.create({
    user: userId,
    name: n.name,
    items: [...ok].map((bottle) => ({ bottle, addedAt: now })),
  });
  logAudit(req, 'picklist.create', { type: 'picklist', id: list._id }, { name: list.name, bottles: ok.size });
  return { list: summary(list.toObject()), added: ok.size, skipped };
}

async function renamePickList(userId, id, name, req) {
  const n = parseName(name);
  if (n.error) return err(400, n.error);
  const list = await PickList.findOneAndUpdate(
    { _id: isValidId(id) ? id : null, user: userId },
    { $set: { name: n.name } },
    { new: true },
  ).lean();
  if (!list) return err(404, 'Pick list not found');
  logAudit(req, 'picklist.rename', { type: 'picklist', id: list._id }, { name: list.name });
  return { list: summary(list) };
}

async function addToPickList(userId, id, bottleIds, req) {
  const parsed = parseBottleIds(bottleIds);
  if (parsed.error) return err(400, parsed.error);
  const list = await findOwnList(userId, id);
  if (!list) return err(404, 'Pick list not found');
  const { ok, skipped } = await sortAddable(userId, parsed.ids);
  // Twice at most: a concurrent add of the same bottle makes the guarded
  // update miss, and the second pass sees it already on the list.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = attempt === 0 ? list : await findOwnList(userId, id);
    if (!current) return err(404, 'Pick list not found');
    const onList = new Set((current.items || []).map((it) => String(it.bottle)));
    const fresh = [...ok].filter((b) => !onList.has(b));
    const already = [...ok].filter((b) => onList.has(b)).map((b) => ({ id: b, reason: 'already_on_list' }));
    if (!fresh.length) return { list: summary(current), added: 0, skipped: [...skipped, ...already] };
    const room = MAX_ITEMS_PER_LIST - onList.size;
    if (fresh.length > room) {
      return err(400, `A pick list holds at most ${MAX_ITEMS_PER_LIST} bottles; this one has room for ${Math.max(0, room)} more.`);
    }
    const now = new Date();
    const updated = await PickList.findOneAndUpdate(
      {
        _id: current._id, user: userId,
        'items.bottle': { $nin: fresh.map((b) => new mongoose.Types.ObjectId(b)) },
        // The cap holds even against a concurrent add: no item at this index yet.
        [`items.${MAX_ITEMS_PER_LIST - fresh.length}`]: { $exists: false },
      },
      { $push: { items: { $each: fresh.map((bottle) => ({ bottle, addedAt: now, pickedAt: null })) } } },
      { new: true },
    ).lean();
    if (updated) {
      logAudit(req, 'picklist.add', { type: 'picklist', id: updated._id }, { name: updated.name, bottles: fresh.length });
      return { list: summary(updated), added: fresh.length, skipped: [...skipped, ...already] };
    }
  }
  return err(409, 'The list changed while adding; try again');
}

async function removeFromPickList(userId, id, bottleIds, req) {
  const parsed = parseBottleIds(bottleIds);
  if (parsed.error) return err(400, parsed.error);
  const ids = parsed.ids.map((b) => new mongoose.Types.ObjectId(b));
  const before = await findOwnList(userId, id);
  if (!before) return err(404, 'Pick list not found');
  const list = await PickList.findOneAndUpdate(
    { _id: before._id, user: userId },
    { $pull: { items: { bottle: { $in: ids } } } },
    { new: true },
  ).lean();
  if (!list) return err(404, 'Pick list not found');
  const removed = (before.items || []).length - (list.items || []).length;
  if (removed > 0) logAudit(req, 'picklist.remove', { type: 'picklist', id: list._id }, { name: list.name, bottles: removed });
  return { list: summary(list), removed };
}

/** Tick (picked=true) or untick bottles on the list. Not audited: it is where the user is in the cellar, not data. */
async function setPicked(userId, id, bottleIds, picked) {
  const parsed = parseBottleIds(bottleIds);
  if (parsed.error) return err(400, parsed.error);
  if (typeof picked !== 'boolean') return err(400, 'picked must be true or false');
  const ids = parsed.ids.map((b) => new mongoose.Types.ObjectId(b));
  const list = await PickList.findOneAndUpdate(
    { _id: isValidId(id) ? id : null, user: userId },
    { $set: { 'items.$[it].pickedAt': picked ? new Date() : null } },
    { new: true, arrayFilters: [{ 'it.bottle': { $in: ids } }] },
  ).lean();
  if (!list) return err(404, 'Pick list not found');
  return { list: summary(list) };
}

async function deletePickList(userId, id, req) {
  const list = await PickList.findOneAndDelete({ _id: isValidId(id) ? id : null, user: userId }).lean();
  if (!list) return err(404, 'Pick list not found');
  logAudit(req, 'picklist.delete', { type: 'picklist', id: list._id }, { name: list.name, bottles: (list.items || []).length });
  return { deleted: true };
}

/**
 * The list as the page shows it: each bottle with its wine, cellar, rack and
 * slot, in walking order — cellar by name, its racks grouped as the rack page
 * groups them (group, then the order they were made), slots in order, bottles
 * not in a rack last. A bottle the user can no longer see is 'unavailable'.
 */
async function getPickListView(userId, id) {
  const list = await findOwnList(userId, id);
  if (!list) return err(404, 'Pick list not found');
  const ids = (list.items || []).map((it) => it.bottle);

  const bottles = ids.length
    ? await Bottle.find({ _id: { $in: ids } })
      .select('wineDefinition vintage bottleSize status cellar location consumedAt')
      .populate({ path: 'wineDefinition', select: 'name producer type colour' })
      .lean()
    : [];
  const cellarIds = [...new Set(bottles.map((b) => String(b.cellar)))];
  const cellars = cellarIds.length
    ? await Cellar.find({ _id: { $in: cellarIds }, deletedAt: null }).select('name user members').lean()
    : [];
  const visibleCellars = new Map(cellars.filter((c) => getCellarRole(c, userId)).map((c) => [String(c._id), c]));
  const seen = bottles.filter((b) => visibleCellars.has(String(b.cellar)));

  // Where each bottle sits, read live.
  const slotOf = new Map();
  const seenIds = seen.map((b) => b._id);
  if (seenIds.length) {
    const visibleIds = [...visibleCellars.keys()];
    const [racks, layouts] = await Promise.all([
      Rack.find({ cellar: { $in: visibleIds }, deletedAt: null, 'slots.bottle': { $in: seenIds } })
        .select('name group slots.position slots.bottle cellar createdAt').lean(),
      CellarLayout.find({ cellar: { $in: visibleIds } }).select('cellar rackPlacements.rack').lean(),
    ]);
    const inRoom = new Set();
    for (const l of layouts) for (const rp of l.rackPlacements || []) inRoom.add(String(rp.rack?._id || rp.rack));
    // Walk order within a cellar: racks of one group together (groups by their
    // first rack), then in the order they were made; ungrouped racks after.
    const firstOfGroup = new Map();
    for (const r of [...racks].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      const g = `${r.cellar}|${r.group || ''}`;
      if (!firstOfGroup.has(g)) firstOfGroup.set(g, new Date(r.createdAt).getTime());
    }
    const order = new Map([...racks]
      .sort((a, b) => {
        const ga = a.group ? firstOfGroup.get(`${a.cellar}|${a.group}`) : Infinity;
        const gb = b.group ? firstOfGroup.get(`${b.cellar}|${b.group}`) : Infinity;
        return ga - gb || new Date(a.createdAt) - new Date(b.createdAt);
      })
      .map((r, i) => [String(r._id), i]));
    const wanted = new Set(seenIds.map(String));
    for (const rack of racks) {
      for (const s of rack.slots || []) {
        const bid = s.bottle && String(s.bottle);
        if (!bid || !wanted.has(bid)) continue;
        slotOf.set(bid, {
          rackId: rack._id, rackName: rack.name, rackGroup: rack.group || null,
          position: s.position, inRoom: inRoom.has(String(rack._id)), order: order.get(String(rack._id)),
        });
      }
    }
  }

  const bottleById = new Map(seen.map((b) => [String(b._id), b]));
  const items = (list.items || []).map((it) => {
    const b = bottleById.get(String(it.bottle));
    if (!b) return { bottleId: it.bottle, addedAt: it.addedAt, pickedAt: it.pickedAt, state: 'unavailable' };
    const cellar = visibleCellars.get(String(b.cellar));
    const w = b.wineDefinition || {};
    return {
      bottleId: b._id,
      addedAt: it.addedAt,
      pickedAt: it.pickedAt,
      state: b.status === 'active' ? 'in_cellar' : (b.status === 'ordered' ? 'ordered' : 'drunk'),
      status: b.status,
      wine: { id: w._id || null, name: w.name || '', producer: w.producer || '', type: w.type || null, colour: w.colour || null },
      vintage: b.vintage,
      bottleSize: b.bottleSize,
      cellar: { id: cellar._id, name: cellar.name },
      rack: slotOf.get(String(b._id)) || null,
      location: b.location || null,
    };
  });

  const rank = (it) => {
    if (it.state === 'unavailable') return [2, '', 0, 0];
    return [it.state === 'in_cellar' ? 0 : 1, it.cellar.name.toLowerCase(), it.rack ? it.rack.order : Infinity, it.rack ? it.rack.position : Infinity];
  };
  items.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] < rb[i]) return -1;
      if (ra[i] > rb[i]) return 1;
    }
    return (a.wine?.name || '').localeCompare(b.wine?.name || '');
  });

  return { list: { ...summary(list), items } };
}

module.exports = {
  listPickLists, createPickList, renamePickList, addToPickList, removeFromPickList,
  setPicked, deletePickList, getPickListView, parseBottleIds,
};
