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
const User = require('../models/User');
const { isValidId } = require('../utils/validation');
const { validateValue, validateKeyDefinition } = require('../utils/personalDataTypes');

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

  const checked = validateKeyDefinition(newKey || {});
  if (!checked.ok) return fail('invalid', checked.error);
  const { def } = checked;

  // def.name is guaranteed a plain string by validateKeyDefinition; $eq for
  // the same local no-injection property as above.
  const existing = await PersonalDataKey.findOne({
    user: userId,
    nameKey: { $eq: def.name.toLowerCase() },
  });
  if (existing) {
    if (existing.type !== def.type) {
      return fail(
        'type_conflict',
        `You already use "${existing.name}" as a ${existing.type} key — a key keeps one type`
      );
    }
    return { ok: true, key: existing };
  }

  const count = await PersonalDataKey.countDocuments({ user: userId });
  if (count >= KEYS_PER_USER) {
    return fail('limit', `Key limit reached (max ${KEYS_PER_USER})`);
  }
  const key = await PersonalDataKey.create({ user: userId, ...def });
  return { ok: true, key, created: true };
}

/**
 * Create an entry on a bottle (level 'bottle') or its wine (level 'wine').
 * Caller has already resolved bottle access for userId.
 */
async function createEntry(userId, bottle, { level, keyId, newKey, value }) {
  if (level !== 'wine' && level !== 'bottle') {
    return fail('invalid', "level must be 'wine' or 'bottle'");
  }
  if (level === 'wine' && !bottle.wineDefinition) {
    return fail('invalid', 'This bottle has no wine record to attach wine-level data to');
  }
  if (await isBanned(userId)) {
    return fail('banned', 'You are banned from posting content visible to other users');
  }

  const keyRes = await resolveKey(userId, { keyId, newKey });
  if (!keyRes.ok) return keyRes;
  const { key } = keyRes;

  const checked = validateValue(key, value);
  if (!checked.ok) return fail('invalid', checked.error);

  const target =
    level === 'wine' ? { wineDefinition: bottle.wineDefinition } : { bottle: bottle._id };
  const count = await PersonalDataEntry.countDocuments({ author: userId, ...target });
  if (count >= ENTRIES_PER_TARGET) {
    return fail('limit', `Entry limit reached for this ${level} (max ${ENTRIES_PER_TARGET})`);
  }

  const entry = await PersonalDataEntry.create({
    author: userId,
    key: key._id,
    targetType: level,
    ...target,
    value: checked.value,
  });
  await entry.populate([{ path: 'key' }, { path: 'author', select: AUTHOR_SELECT }]);
  return { ok: true, entry: serializeEntry(entry), keyCreated: !!keyRes.created };
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
  return { ok: true, entry: serializeEntry(entry), prevValue };
}

/** Author-only. Not-found for anyone else — no existence oracle. */
async function deleteEntry(userId, entryId) {
  if (!isValidId(String(entryId))) return fail('invalid', 'Invalid entry id');
  const entry = await PersonalDataEntry.findOneAndDelete({ _id: { $eq: String(entryId) }, author: userId })
    .populate('key');
  if (!entry) return fail('not_found', 'Entry not found');
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

module.exports = {
  KEYS_PER_USER,
  ENTRIES_PER_TARGET,
  listForBottle,
  createEntry,
  updateEntry,
  deleteEntry,
  listKeys,
  // exported for tests
  serializeEntry,
  cellarMemberIds,
};
