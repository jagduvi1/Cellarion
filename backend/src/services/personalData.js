/**
 * Personal typed key/value data (issue #986) — ONE implementation shared by
 * the REST routes (routes/personalData.js) and the MCP tools
 * (mcp/tools/personalData.js), following the ownerInquiryOps pattern so the
 * two surfaces cannot drift on visibility or validation semantics.
 *
 * Results are transport-neutral: { ok: true, ... } or { ok: false, code,
 * message } with codes the callers map to HTTP statuses / MCP fail codes:
 *   invalid       → 400
 *   banned        → 403
 *   not_found     → 404
 *   type_conflict → 409
 *   limit         → 429-ish (400 on REST)
 *
 * Visibility rules implemented here:
 *  - bottle-level entries belong to the bottle: anyone who can see the bottle
 *    sees them, whoever wrote them (they stay when the author leaves).
 *  - wine-level entries follow the person: on a given bottle, only entries
 *    authored by CURRENT members of that bottle's cellar are returned, so a
 *    departed member's wine-level entries stop being visible automatically,
 *    and nobody's wine-level data is ever browsable outside a shared bottle.
 */
const PersonalDataKey = require('../models/PersonalDataKey');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const SavedDashboard = require('../models/SavedDashboard');
const SavedView = require('../models/SavedView');
const User = require('../models/User');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const { isValidId } = require('../utils/validation');
const { validateValue, validateKeyDefinition, TYPES } = require('../utils/personalDataTypes');
const { bumpDataVersion } = require('./dataVersion');

// Caps — this is user-writable storage (GDPR data-minimisation + abuse bound).
const KEYS_PER_USER = 100;
const ENTRIES_PER_TARGET = 20;

const AUTHOR_SELECT = 'username displayName';

const fail = (code, message) => ({ ok: false, code, message });

/** Entries are visible to co-members, so the discussion ban applies to writes. */
async function isBanned(userId) {
  const u = await User.findById(userId).select('discussionBan');
  return !!(u && u.isDiscussionBanned());
}

function serializeEntry(entry) {
  const key = entry.key || {};
  const author = entry.author || {};
  return {
    _id: entry._id,
    level: entry.targetType,
    // null on wine-level = every vintage; set = only bottles of that vintage.
    vintage: entry.vintage || null,
    key: {
      _id: key._id,
      name: key.name,
      type: key.type,
      unit: key.unit || null,
      enumOptions: key.enumOptions || null,
    },
    value: entry.value,
    author: {
      _id: author._id,
      username: author.username || null,
      displayName: author.displayName || null,
    },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function serializeKey(key) {
  return {
    _id: key._id,
    name: key.name,
    type: key.type,
    unit: key.unit || null,
    enumOptions: key.enumOptions || null,
  };
}

/** All user ids with access to the cellar: owner + members. */
function cellarMemberIds(cellar) {
  const ids = [cellar.user?._id ?? cellar.user];
  for (const m of cellar.members || []) ids.push(m.user?._id ?? m.user);
  return ids.filter(Boolean);
}

/**
 * Everything visible on a bottle's page: its bottle-level entries plus the
 * wine-level entries of current cellar members. Caller has already resolved
 * access (requireBottleAccess / resolveBottleAccess).
 */
async function listForBottle(bottle, cellar) {
  const [bottleEntries, wineEntries] = await Promise.all([
    PersonalDataEntry.find({ bottle: bottle._id })
      .sort({ createdAt: 1 })
      .populate('key')
      .populate('author', AUTHOR_SELECT)
      .lean(),
    bottle.wineDefinition
      ? PersonalDataEntry.find({
          wineDefinition: bottle.wineDefinition,
          author: { $in: cellarMemberIds(cellar) },
          // Vintage-scoped wine entries only surface on bottles of that
          // vintage (user ticket 6a853211 — ABV drifts year to year).
          $or: [{ vintage: null }, { vintage: bottle.vintage || null }],
        })
          .sort({ createdAt: 1 })
          .populate('key')
          .populate('author', AUTHOR_SELECT)
          .lean()
      : [],
  ]);
  return {
    ok: true,
    bottleEntries: bottleEntries.map(serializeEntry),
    wineEntries: wineEntries.map(serializeEntry),
  };
}

const idStr = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);
// What listForBottles reads of an entry: who, which key, where, which vintage, the value.
const ENTRY_LIST_SELECT = 'author key targetType bottle wineDefinition vintage value createdAt';

/**
 * listForBottle for many bottles at once — EXACTLY its visibility rules, in a
 * bounded number of queries whatever the bottle count (two finds with their
 * key populate, one author lookup), for GET /api/inventory:
 *  - a bottle's bottle-level entries, by anyone;
 *  - the wine-level entries on its wine authored by a CURRENT member (or the
 *    owner) of that bottle's cellar, vintage null or equal to the bottle's.
 * The wine-level query is one $or arm per cellar (its wines × its members),
 * so a member's entries are never even read for a cellar they are not in.
 * Caller has already resolved access to every bottle and cellar passed.
 *
 * @param {Array<{ _id, cellar, wineDefinition, vintage }>} bottles  wineDefinition/cellar as ids or populated docs
 * @param {Array<{ _id, user, members }>} cellars  the cellars those bottles are in
 * @returns {Promise<Map<string, Array<{ key, type, unit, value, level, by }>>>}  bottle id → entries
 *   (bottle-level first, then wine-level, each oldest first — the listForBottle order);
 *   every bottle passed has an entry, [] when nothing is visible.
 */
async function listForBottles(bottles, cellars) {
  const out = new Map();
  if (!Array.isArray(bottles) || bottles.length === 0) return out;
  for (const b of bottles) out.set(String(b._id), []);

  const cellarById = new Map((cellars || []).map((c) => [String(c._id), c]));
  const membersOf = new Map();
  for (const [id, c] of cellarById) membersOf.set(id, new Set(cellarMemberIds(c).map(String)));

  // Each cellar's wines: the wine-level arm for that cellar reads exactly those.
  const winesByCellar = new Map();
  for (const b of bottles) {
    const cid = idStr(b.cellar);
    const wid = idStr(b.wineDefinition);
    if (!wid || !cid || !cellarById.has(cid)) continue;
    if (!winesByCellar.has(cid)) winesByCellar.set(cid, new Set());
    winesByCellar.get(cid).add(wid);
  }
  const wineArms = [...winesByCellar].map(([cid, wines]) => ({
    wineDefinition: { $in: [...wines] },
    author: { $in: [...membersOf.get(cid)] },
  }));

  const [bottleEntries, wineEntries] = await Promise.all([
    PersonalDataEntry.find({ bottle: { $in: bottles.map((b) => b._id) } })
      .select(ENTRY_LIST_SELECT)
      .sort({ createdAt: 1 })
      .populate('key', 'name type unit')
      .lean(),
    wineArms.length
      ? PersonalDataEntry.find({ $or: wineArms })
        .select(ENTRY_LIST_SELECT)
        .sort({ createdAt: 1 })
        .populate('key', 'name type unit')
        .lean()
      : [],
  ]);

  // Authors' usernames in one query. Not a populate: the raw author id is
  // what the member check below compares, exactly as listForBottle's query.
  const authorIds = [...new Set([...bottleEntries, ...wineEntries].map((e) => idStr(e.author)).filter(Boolean))];
  const usernames = new Map();
  if (authorIds.length) {
    for (const u of await User.find({ _id: { $in: authorIds } }).select('username').lean()) {
      usernames.set(String(u._id), u.username || null);
    }
  }

  const shape = (e) => ({
    key: e.key.name,
    type: e.key.type || null,
    unit: e.key.unit || null,
    value: e.value,
    level: e.targetType,
    by: usernames.get(idStr(e.author)) || null,
  });

  for (const e of bottleEntries) {
    // An entry whose key is gone has no name to show (a key with entries
    // cannot be deleted, so this is a leftover, never a live entry).
    if (!e.key || !e.key.name) continue;
    const list = out.get(idStr(e.bottle));
    if (list) list.push(shape(e));
  }

  // Wine-level: per bottle, the same three conditions listForBottle queries.
  const byWine = new Map();
  for (const e of wineEntries) {
    if (!e.key || !e.key.name) continue;
    const wid = idStr(e.wineDefinition);
    if (!byWine.has(wid)) byWine.set(wid, []);
    byWine.get(wid).push(e);
  }
  for (const b of bottles) {
    const wid = idStr(b.wineDefinition);
    const candidates = wid ? byWine.get(wid) : null;
    if (!candidates) continue;
    const members = membersOf.get(idStr(b.cellar));
    if (!members) continue;
    const vintage = b.vintage || null;
    const list = out.get(String(b._id));
    for (const e of candidates) {
      if (!members.has(idStr(e.author))) continue;
      if (e.vintage != null && e.vintage !== vintage) continue;
      list.push(shape(e));
    }
  }
  return out;
}

/**
 * Move the data version (services/dataVersion) of everyone whose view of
 * personal data this write changes, so GET /api/inventory's ETag — and the
 * other version-keyed caches — move with it. Who that is:
 *  - the author, always (their own cellars, and the tag of every member of
 *    a cellar they own includes their version);
 *  - for bottle-level entries, the owner of each bottle's cellar (every
 *    member's tag includes the owner's version);
 *  - for wine-level entries, the owners of every cellar the author is a
 *    member of — a superset of "the cellars where those entries show".
 * Never throws: a version that does not move is a refresh that comes at the
 * tag's max age, never a failed write.
 *
 * @param {*} authorId
 * @param {{ cellarIds?: Array, bottleIds?: Array, wineLevel?: boolean }} audience
 */
async function bumpPersonalDataViewers(authorId, { cellarIds = [], bottleIds = [], wineLevel = false } = {}) {
  try {
    bumpDataVersion(authorId);
    const cellars = new Set(cellarIds.map(idStr).filter(Boolean));
    const bottleList = bottleIds.filter(Boolean);
    if (bottleList.length) {
      for (const c of await Bottle.distinct('cellar', { _id: { $in: bottleList } })) if (c) cellars.add(String(c));
    }
    const owners = new Set();
    if (cellars.size) {
      for (const o of await Cellar.distinct('user', { _id: { $in: [...cellars] } })) if (o) owners.add(String(o));
    }
    if (wineLevel) {
      for (const o of await Cellar.distinct('user', { 'members.user': authorId, deletedAt: null })) if (o) owners.add(String(o));
    }
    owners.delete(String(authorId));
    for (const o of owners) bumpDataVersion(o);
  } catch (err) {
    console.error('Personal data version bump failed:', err.message);
  }
}

/** bumpPersonalDataViewers' audience for one stored entry (or its raw target refs). */
function entryAudience(entry) {
  return entry.targetType === 'wine' || (!entry.bottle && entry.wineDefinition)
    ? { wineLevel: true }
    : { bottleIds: [entry.bottle] };
}

/** The audience of every entry under one key — for a rename, which shows on all of them. */
async function bumpKeyViewers(userId, keyId) {
  try {
    const [bottleIds, wineEntry] = await Promise.all([
      PersonalDataEntry.distinct('bottle', { key: keyId, targetType: 'bottle' }),
      PersonalDataEntry.exists({ key: keyId, targetType: 'wine' }),
    ]);
    await bumpPersonalDataViewers(userId, { bottleIds, wineLevel: !!wineEntry });
  } catch (err) {
    bumpDataVersion(userId);
    console.error('Personal data version bump failed:', err.message);
  }
}

/**
 * Resolve the key for a new entry: an existing key id, or match-or-create by
 * name. A name that matches an existing key of the SAME type reuses it (the
 * stored definition wins over any options/unit supplied); a type mismatch is
 * a conflict, never a silent second key.
 */
async function resolveKey(userId, { keyId, newKey }) {
  if (keyId) {
    if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
    // $eq on the client-supplied id: isValidId already rejects operator
    // objects, but the explicit $eq makes the no-injection property local to
    // the query instead of depending on the guard above (CodeQL js/sql-injection).
    const key = await PersonalDataKey.findOne({ _id: { $eq: String(keyId) }, user: userId });
    if (!key) return fail('not_found', 'Key not found');
    return { ok: true, key };
  }

  // Name first, type second: an EXISTING key is matched on its name alone, so
  // a caller who declared the key once does not have to repeat its type on
  // every write (chfish ticket 6aa6c90e, 2026-09-13 — the MCP schema promised
  // "required only when the key is new" and this function made a liar of it
  // by validating the full definition before looking the name up). A type
  // that IS supplied still has to agree with the stored one; only a genuinely
  // new key needs the full definition. The name is trimmed here exactly as
  // validateKeyDefinition trims it, so the lookup key matches what create
  // would have stored; $eq for the local no-injection property as above.
  const rawName = typeof (newKey && newKey.name) === 'string' ? newKey.name.trim() : '';
  if (!rawName) return fail('invalid', 'Key name is required');
  const existing = await PersonalDataKey.findOne({
    user: userId,
    nameKey: { $eq: rawName.toLowerCase() },
  });
  if (existing) {
    const suppliedType = newKey && newKey.type;
    // A type that is not a type at all is still the old message, not a
    // "keeps one type" conflict (audit 2026-09-14 L4).
    if (suppliedType && !TYPES.includes(suppliedType)) {
      return fail('invalid', `Key type must be one of: ${TYPES.join(', ')}`);
    }
    if (suppliedType && existing.type !== suppliedType) {
      return fail(
        'type_conflict',
        `You already use "${existing.name}" as a ${existing.type} key — a key keeps one type`
      );
    }
    return { ok: true, key: existing };
  }

  const checked = validateKeyDefinition(newKey || {});
  // needsType lets the MCP layer add its "pass key_type" hint ONLY here —
  // where the key is genuinely new — and not on a value error for an
  // existing key (audit 2026-09-14 L2).
  if (!checked.ok) return { ...fail('invalid', checked.error), needsType: !(newKey && newKey.type) };
  // A genuinely new key is NOT written here: the caller validates the value
  // against the definition and checks the room on the target first, then
  // creates it (createKey) — so a refused value never leaves a typed key
  // behind with no entry (release audit 2026-09-27, L).
  return { ok: true, key: null, def: checked.def };
}

/** Write the key resolveKey deferred, within the per-user cap. */
async function createKey(userId, def) {
  const count = await PersonalDataKey.countDocuments({ user: userId });
  if (count >= KEYS_PER_USER) {
    return fail('limit', `Key limit reached (max ${KEYS_PER_USER})`);
  }
  const key = await PersonalDataKey.create({ user: userId, ...def });
  return { ok: true, key };
}

/**
 * Create an entry on a bottle (level 'bottle') or its wine (level 'wine').
 * Caller has already resolved bottle access for userId.
 *
 * `dedupe` returns the caller's existing entry for the same key and target
 * slot instead of writing a second one. Off by default — the bottle page has
 * always allowed a repeat and nothing should change under it — and ON for the
 * add-bottle form, where a six-bottle batch posts the same WINE-level field
 * once per bottle and a retry re-posts what the first attempt already wrote.
 */
async function createEntry(userId, bottle, { level, keyId, newKey, value, vintageScoped = false }, { dedupe = false } = {}) {
  if (level !== 'wine' && level !== 'bottle') {
    return fail('invalid', "level must be 'wine' or 'bottle'");
  }
  if (level === 'wine' && !bottle.wineDefinition) {
    return fail('invalid', 'This bottle has no wine record to attach wine-level data to');
  }
  // "Every bottle of this vintage" (user ticket 6a853211): a wine-level entry
  // narrowed to THE BOTTLE'S vintage — derived server-side, never client text.
  if (vintageScoped && level !== 'wine') {
    return fail('invalid', 'vintage scope only applies to wine-level entries — a bottle-level entry already has its vintage');
  }
  if (vintageScoped && !(typeof bottle.vintage === 'string' && bottle.vintage.trim())) {
    return fail('invalid', 'This bottle has no vintage to scope to');
  }
  if (await isBanned(userId)) {
    return fail('banned', 'You are banned from posting content visible to other users');
  }

  const keyRes = await resolveKey(userId, { keyId, newKey });
  if (!keyRes.ok) return keyRes;
  // An existing key, or the definition of a new one not written yet (see
  // resolveKey) — the same shape for validation either way.
  let key = keyRes.key;
  const keyDef = key || keyRes.def;

  const checked = validateValue(keyDef, value);
  if (!checked.ok) return fail('invalid', checked.error);

  const target =
    level === 'wine' ? { wineDefinition: bottle.wineDefinition } : { bottle: bottle._id };
  const slotVintage = vintageScoped ? bottle.vintage.trim() : null;

  // A key that does not exist yet can have no earlier entry to dedupe against.
  if (dedupe && key) {
    // Rows written before the vintage field existed have no `vintage` at all,
    // and Mongo matches a missing field against null — so the default slot
    // finds them, exactly as the RegistryDataValue index does.
    const existing = await PersonalDataEntry.findOne({
      author: userId, key: key._id, ...target, vintage: slotVintage,
    })
      .populate('key')
      .populate('author', AUTHOR_SELECT)
      .lean();
    // Only the SAME value is a duplicate. A different one is the user saying
    // something new, and swallowing it would lose what they typed with no
    // trace — so it comes back as a conflict they can act on, rather than
    // being quietly overwritten from a form that cannot show them the old
    // value. Every cast value is a primitive (dates canonicalise to ISO
    // strings in personalDataTypes), so === is the whole comparison.
    if (existing && existing.value === checked.value) {
      return { ok: true, entry: serializeEntry(existing), deduped: true };
    }
    if (existing) {
      return fail(
        'conflict',
        `You already recorded "${key.name}" here as ${existing.value} — change it on the bottle page`
      );
    }
  }

  const count = await PersonalDataEntry.countDocuments({ author: userId, ...target });
  if (count >= ENTRIES_PER_TARGET) {
    return fail('limit', `Entry limit reached for this ${level} (max ${ENTRIES_PER_TARGET})`);
  }

  // Everything that could refuse has passed: now the new key is written.
  let keyCreated = false;
  if (!key) {
    const made = await createKey(userId, keyRes.def);
    if (!made.ok) return made;
    key = made.key;
    keyCreated = true;
  }

  const entry = await PersonalDataEntry.create({
    author: userId,
    key: key._id,
    targetType: level,
    ...target,
    ...(slotVintage ? { vintage: slotVintage } : {}),
    value: checked.value,
  });
  await entry.populate([{ path: 'key' }, { path: 'author', select: AUTHOR_SELECT }]);
  await bumpPersonalDataViewers(userId, level === 'wine'
    ? { wineLevel: true }
    : { cellarIds: [bottle.cellar], bottleIds: bottle.cellar ? [] : [bottle._id] });
  return { ok: true, entry: serializeEntry(entry), keyCreated };
}

/** Author-only. Not-found for anyone else — no existence oracle. */
async function updateEntry(userId, entryId, value) {
  if (!isValidId(String(entryId))) return fail('invalid', 'Invalid entry id');
  const entry = await PersonalDataEntry.findOne({ _id: { $eq: String(entryId) }, author: userId }).populate('key');
  if (!entry) return fail('not_found', 'Entry not found');
  if (await isBanned(userId)) {
    return fail('banned', 'You are banned from posting content visible to other users');
  }
  if (!entry.key) return fail('invalid', 'This entry’s key no longer exists');

  const checked = validateValue(entry.key, value);
  if (!checked.ok) return fail('invalid', checked.error);

  const prevValue = entry.value;
  entry.value = checked.value;
  await entry.save();
  await entry.populate('author', AUTHOR_SELECT);
  await bumpPersonalDataViewers(userId, entryAudience(entry));
  return { ok: true, entry: serializeEntry(entry), prevValue };
}

/** Author-only. Not-found for anyone else — no existence oracle. */
async function deleteEntry(userId, entryId) {
  if (!isValidId(String(entryId))) return fail('invalid', 'Invalid entry id');
  const entry = await PersonalDataEntry.findOneAndDelete({ _id: { $eq: String(entryId) }, author: userId })
    .populate('key');
  if (!entry) return fail('not_found', 'Entry not found');
  await bumpPersonalDataViewers(userId, entryAudience(entry));
  return {
    ok: true,
    entry: serializeEntry(entry),
    // Raw target refs so a caller (MCP undo) can recreate the row.
    target: {
      wineDefinition: entry.wineDefinition || null,
      bottle: entry.bottle || null,
    },
  };
}

/** The caller's own key vocabulary, for type-ahead. */
async function listKeys(userId) {
  const keys = await PersonalDataKey.find({ user: userId }).sort({ nameKey: 1 }).lean();
  return { ok: true, keys: keys.map(serializeKey) };
}

const KEY_NAME_MAX = 60;
const KEY_UNIT_MAX = 20;
const NUMERIC_TYPES = ['integer', 'decimal'];

/** The caller's own key, or not_found for everyone else (no existence oracle). */
async function ownKey(userId, keyId) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  const key = await PersonalDataKey.findOne({ _id: { $eq: String(keyId) }, user: userId });
  if (!key) return fail('not_found', 'Key not found');
  return { ok: true, key };
}

/**
 * Rename a key and/or change its unit (chfish ticket 6aa6c95e, 2026-09-13).
 *
 * A key's name, type and unit are fixed by the very first write — the moment
 * the user knows least about the data they are about to enter — so a typo or
 * a wrong scale used to be permanent. The id never changes, so stored entries
 * and analytics field ids stay valid. Rules:
 *   - name: any time; must not collide with another of the user's keys
 *     (case-insensitive, the unique {user, nameKey} index is the last word).
 *   - unit: numeric keys only, and only while the key holds NO entries —
 *     a unit is part of what every stored value means. An empty string
 *     clears it.
 *   - type: never (every stored value would need revalidation; not offered).
 * Returns the previous name/unit so a caller (MCP undo) can restore them.
 */
async function updateKey(userId, keyId, { name, unit, enumOptions } = {}) {
  const found = await ownKey(userId, keyId);
  if (!found.ok) return found;
  const { key } = found;

  const wantsName = name !== undefined;
  const wantsUnit = unit !== undefined;
  const wantsOptions = enumOptions !== undefined;
  if (!wantsName && !wantsUnit && !wantsOptions) {
    return fail('invalid', 'Nothing to change — pass name, unit and/or enumOptions');
  }

  let cleanName = key.name;
  if (wantsName) {
    cleanName = typeof name === 'string' ? name.trim() : '';
    if (!cleanName) return fail('invalid', 'Key name is required');
    if (cleanName.length > KEY_NAME_MAX) return fail('invalid', `Key name too long (max ${KEY_NAME_MAX} characters)`);
    // A key's name is visible to shared-cellar members on every entry that
    // carries it — the same surface the discussion ban protects on writes
    // (audit 2026-09-14 M1).
    if (await isBanned(userId)) {
      return fail('banned', 'You are banned from posting content visible to other users');
    }
  }

  let cleanUnit = key.unit || null;
  if (wantsUnit) {
    if (!NUMERIC_TYPES.includes(key.type)) {
      return fail('invalid', `Only integer and decimal keys carry a unit — "${key.name}" is a ${key.type} key`);
    }
    const entries = await PersonalDataEntry.countDocuments({ key: key._id });
    if (entries > 0) {
      return fail('in_use', `"${key.name}" already holds ${entries} entr${entries === 1 ? 'y' : 'ies'} — the unit is part of what each stored value means, so it cannot change any more`);
    }
    cleanUnit = typeof unit === 'string' ? unit.trim() : '';
    if (cleanUnit.length > KEY_UNIT_MAX) return fail('invalid', `Unit too long (max ${KEY_UNIT_MAX} characters)`);
    cleanUnit = cleanUnit || null;
  }

  // The allowed values of a list key (user ticket 2026-10-27: a list could
  // never grow after its creation). The new list replaces the old one under
  // the creation rules; a value some entry still holds must stay on it, so
  // no stored value ever falls outside its key's definition.
  let cleanOptions = key.enumOptions ? [...key.enumOptions] : null;
  if (wantsOptions) {
    if (key.type !== 'enum') {
      return fail('invalid', `Only "one of a list" keys carry allowed values — "${key.name}" is a ${key.type} key`);
    }
    const checked = validateKeyDefinition({ name: key.name, type: 'enum', enumOptions });
    if (!checked.ok) return fail('invalid', checked.error);
    cleanOptions = checked.def.enumOptions;
    const dropped = (key.enumOptions || []).filter((o) => !cleanOptions.includes(o));
    if (dropped.length > 0) {
      const inUse = await PersonalDataEntry.distinct('value', { key: key._id, value: { $in: dropped } });
      if (inUse.length > 0) {
        const list = inUse.map((v) => `"${v}"`).join(', ');
        return fail('in_use', `${list} ${inUse.length === 1 ? 'is' : 'are'} still used by an entry — keep ${inUse.length === 1 ? 'it' : 'them'} on the list, or change those entries first`);
      }
    }
  }

  const prev = {
    name: key.name,
    unit: key.unit || null,
    ...(key.type === 'enum' ? { enumOptions: key.enumOptions ? [...key.enumOptions] : null } : {}),
  };
  key.name = cleanName;
  key.nameKey = cleanName.toLowerCase();
  key.unit = cleanUnit || undefined;
  if (wantsOptions) key.enumOptions = cleanOptions;
  try {
    await key.save();
  } catch (err) {
    if (err && err.code === 11000) {
      return fail('conflict', `You already have a key called "${cleanName}"`);
    }
    throw err;
  }
  // The name (unit, allowed values) shows on every entry under the key.
  await bumpKeyViewers(userId, key._id);
  return { ok: true, key: serializeKey(key), prev };
}

/**
 * Delete a key that holds no entries. A key with values behind it is refused
 * — delete or move the entries first, so nothing stored ever loses its
 * definition. Returns the full definition so a caller (MCP undo) can put the
 * key back under the same id.
 */
async function deleteKey(userId, keyId) {
  const found = await ownKey(userId, keyId);
  if (!found.ok) return found;
  const { key } = found;
  const entries = await PersonalDataEntry.countDocuments({ key: key._id });
  if (entries > 0) {
    return fail('in_use', `"${key.name}" still holds ${entries} entr${entries === 1 ? 'y' : 'ies'} — delete them first`);
  }
  // A saved board or table view may filter or group on `personal.<id>`; the
  // analytics engine answers "Unknown field" for a deleted key and the board
  // silently stops opening (audit 2026-09-14 L3). Refuse while referenced.
  const fieldRef = `personal.${String(key._id)}`;
  const [boards, views] = await Promise.all([
    SavedDashboard.find({ user: userId }).select('name query').lean(),
    SavedView.find({ user: userId }).select('name query').lean(),
  ]);
  const referencing = [...boards, ...views].filter((d) => JSON.stringify(d.query || {}).includes(fieldRef)).map((d) => d.name);
  if (referencing.length) {
    return fail('in_use', `"${key.name}" is used by saved analytics (${referencing.slice(0, 3).join(', ')}${referencing.length > 3 ? ', …' : ''}) — remove it there first`);
  }
  const definition = {
    _id: String(key._id), name: key.name, type: key.type,
    unit: key.unit || undefined, enumOptions: key.enumOptions || undefined,
  };
  await PersonalDataKey.deleteOne({ _id: key._id, user: userId });
  // Compensate the count→delete window: an entry written in between would
  // otherwise dangle without a key (audit 2026-09-14 L1). Put the key back
  // under its id and report the key as in use.
  const late = await PersonalDataEntry.countDocuments({ key: key._id });
  if (late > 0) {
    await PersonalDataKey.create({ user: userId, ...definition });
    return fail('in_use', `"${key.name}" received ${late} entr${late === 1 ? 'y' : 'ies'} while being deleted — it was kept`);
  }
  // An empty key shows nowhere; the author's own version still moves.
  await bumpPersonalDataViewers(userId);
  return { ok: true, key: serializeKey(key), definition };
}

module.exports = {
  KEYS_PER_USER,
  ENTRIES_PER_TARGET,
  listForBottle,
  listForBottles,
  bumpPersonalDataViewers,
  bumpKeyViewers,
  createEntry,
  updateEntry,
  deleteEntry,
  listKeys,
  updateKey,
  deleteKey,
  // exported for tests
  serializeEntry,
  cellarMemberIds,
};
