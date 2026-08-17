/**
 * Public key vocabulary + values (#985 Slice B) — ONE implementation shared
 * by the REST routes (routes/registryData.js, routes/admin/registryData.js)
 * and the MCP tools (mcp/tools/registryData.js).
 *
 * The vocabulary is admin-curated: users PROPOSE keys (name + type +
 * rationale), an admin accepts them; users SUGGEST values for accepted keys
 * (type-validated at entry), an admin publishes them. Nothing here writes to
 * WineDefinition and nothing auto-applies — the registry stays human-gated.
 *
 * Results are transport-neutral: { ok: true, ... } | { ok: false, code,
 * message } — codes: invalid | banned | limit | not_found | conflict.
 */
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const User = require('../models/User');
const { findVisibleWine } = require('./wineVisibility');
const { validateValue, validateKeyDefinition } = require('../utils/personalDataTypes');
const { TIER_DAILY } = require('./wineProposalOps');
const { stripHtml } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');
const { logAudit } = require('./audit');

// Names that would shadow first-class record fields — a key called
// "producer" or "region" must never exist beside the real thing.
const RESERVED_NAMES = [
  'producer', 'name', 'appellation', 'region', 'country', 'classification',
  'type', 'grapes', 'vintage', 'body', 'tannin', 'acidity', 'sweetness',
  'flavors', 'flavours', 'description', 'rating', 'price',
];

const fail = (code, message) => ({ ok: false, code, message });

async function loadGatedUser(userId) {
  const user = await User.findById(userId).select('contribution.tier discussionBan');
  if (!user) return { error: fail('not_found', 'User not found') };
  if (user.isDiscussionBanned && user.isDiscussionBanned()) {
    return { error: fail('banned', 'You are banned from posting content visible to other users') };
  }
  return { user };
}

/** Daily budget shared across BOTH suggestion types (keys + values), so the
 * tier cap is one number a user can reason about. */
async function overDailyBudget(userId, tier) {
  const daily = TIER_DAILY[tier] || TIER_DAILY.newcomer;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [keys, values] = await Promise.all([
    RegistryDataKey.countDocuments({ proposedBy: userId, createdAt: { $gt: since } }),
    RegistryDataValue.countDocuments({ suggestedBy: userId, createdAt: { $gt: since } }),
  ]);
  return keys + values >= daily ? daily : null;
}

const serializeKey = (k) => ({
  _id: k._id,
  name: k.name,
  type: k.type,
  unit: k.unit || null,
  enumOptions: k.enumOptions || null,
  status: k.status,
});

/* ── User operations ─────────────────────────────────────────────────── */

/** Propose a new public key. Admin accepts it into the vocabulary. */
async function proposeKey(userId, { name, type, unit, enumOptions, rationale }, { via, req } = {}) {
  const checked = validateKeyDefinition({ name, type, unit, enumOptions });
  if (!checked.ok) return fail('invalid', checked.error);
  const { def } = checked;

  const cleanRationale = stripHtml(typeof rationale === 'string' ? rationale : '').trim();
  if (cleanRationale.length < 10) {
    return fail('invalid', 'Say why this deserves to be a shared field — at least 10 characters.');
  }
  if (cleanRationale.length > 1000) return fail('invalid', 'Rationale must be at most 1000 characters.');

  if (RESERVED_NAMES.includes(def.name.toLowerCase())) {
    return fail('conflict', `"${def.name}" is already a first-class field of the wine record.`);
  }

  const gate = await loadGatedUser(userId);
  if (gate.error) return gate.error;
  const capped = await overDailyBudget(userId, gate.user.contribution?.tier);
  if (capped) return fail('limit', `You have reached today's suggestion limit (${capped}). The limit rises as your accepted contributions grow.`);

  const existing = await RegistryDataKey.findOne({
    nameKey: { $eq: def.name.toLowerCase() },
    status: { $in: ['proposed', 'accepted'] },
  });
  if (existing) {
    return fail('conflict', existing.status === 'accepted'
      ? `"${existing.name}" is already in the vocabulary — suggest a value for it instead.`
      : `"${existing.name}" has already been proposed and is awaiting review.`);
  }

  let key;
  try {
    key = await RegistryDataKey.create({ ...def, rationale: cleanRationale, proposedBy: userId });
  } catch (err) {
    if (err?.code === 11000) {
      return fail('conflict', 'That key has just been proposed by someone else — it is awaiting review.');
    }
    throw err;
  }

  logAudit(req || null, 'registry_data.key_propose',
    { type: 'registry_key', id: key._id },
    { name: key.name, keyType: key.type, ...(via ? { via } : {}) });
  return { ok: true, key: serializeKey(key) };
}

/** The accepted vocabulary (for pickers and the wine-record display). */
async function listAcceptedKeys() {
  const keys = await RegistryDataKey.find({ status: 'accepted' }).sort({ nameKey: 1 }).lean();
  return { ok: true, keys: keys.map(serializeKey) };
}

/** Suggest a value for an ACCEPTED key on a visible wine. */
async function suggestValue(userId, { wineId, keyId, value, reason, evidenceUrl }, { via, req } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  const key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: 'accepted' });
  if (!key) return fail('not_found', 'No such key in the accepted vocabulary');

  const checked = validateValue(key, value);
  if (!checked.ok) return fail('invalid', checked.error);

  let cleanUrl = '';
  if (evidenceUrl !== undefined && evidenceUrl !== null) {
    cleanUrl = String(evidenceUrl).trim();
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      return fail('invalid', 'The evidence link must be an http:// or https:// URL.');
    }
    if (cleanUrl.length > 500) return fail('invalid', 'The evidence link must be at most 500 characters.');
  }
  const cleanReason = stripHtml(typeof reason === 'string' ? reason : '').trim().slice(0, 1000);

  const gate = await loadGatedUser(userId);
  if (gate.error) return gate.error;
  const capped = await overDailyBudget(userId, gate.user.contribution?.tier);
  if (capped) return fail('limit', `You have reached today's suggestion limit (${capped}). The limit rises as your accepted contributions grow.`);

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const wine = await findVisibleWine(String(wineId), { userId, roles: req?.user?.roles || [] });
  if (!wine) return fail('not_found', 'Wine not found');

  // Same-as-published is a no-op the suggester should hear about.
  const published = await RegistryDataValue.findOne({
    wineDefinition: wine._id, key: key._id, status: 'published',
  });
  if (published && String(published.value) === String(checked.value)) {
    return fail('conflict', 'The record already says exactly that — nothing to change.');
  }

  let row;
  try {
    row = await RegistryDataValue.create({
      wineDefinition: wine._id,
      key: key._id,
      value: checked.value,
      suggestedBy: userId,
      ...(cleanUrl ? { evidenceUrl: cleanUrl } : {}),
      ...(cleanReason ? { reason: cleanReason } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return fail('conflict', 'A value for this field is already awaiting review — thank you, it is in the queue.');
    }
    throw err;
  }

  logAudit(req || null, 'registry_data.value_suggest',
    { type: 'wine', id: wine._id },
    { key: key.name, valueId: row._id, ...(via ? { via } : {}) });
  return { ok: true, value: { _id: row._id, key: serializeKey(key), value: row.value, status: row.status } };
}

/**
 * Everything the wine-record section needs for one wine: the accepted
 * vocabulary, published values, and (when userId is given) the caller's own
 * pending suggestions.
 */
async function dataForWine(wineId, userId = null) {
  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const wid = String(wineId);
  const [keys, publishedRows, mine] = await Promise.all([
    RegistryDataKey.find({ status: 'accepted' }).sort({ nameKey: 1 }).lean(),
    RegistryDataValue.find({ wineDefinition: { $eq: wid }, status: 'published' })
      .populate('suggestedBy', 'username displayName').lean(),
    userId
      ? RegistryDataValue.find({ wineDefinition: { $eq: wid }, suggestedBy: userId, status: 'suggested' })
          .select('key value status createdAt').lean()
      : [],
  ]);
  const byKey = new Map(publishedRows.map((v) => [String(v.key), v]));
  const mineByKey = new Map(mine.map((v) => [String(v.key), v]));
  return {
    ok: true,
    fields: keys.map((k) => {
      const pub = byKey.get(String(k._id));
      const own = mineByKey.get(String(k._id));
      return {
        key: serializeKey(k),
        value: pub ? pub.value : null,
        contributedBy: pub
          ? (pub.suggestedBy?.displayName || pub.suggestedBy?.username || null)
          : null,
        mySuggestion: own ? { value: own.value, status: own.status } : null,
      };
    }),
  };
}

/* ── Admin operations ────────────────────────────────────────────────── */

async function listReviewQueues() {
  const [keys, values] = await Promise.all([
    RegistryDataKey.find({ status: 'proposed' }).sort({ createdAt: 1 })
      .populate('proposedBy', 'username displayName contribution.tier').lean(),
    RegistryDataValue.find({ status: 'suggested' }).sort({ createdAt: 1 })
      .populate('key')
      .populate('suggestedBy', 'username displayName contribution.tier')
      .populate('wineDefinition', 'name producer slug').lean(),
  ]);
  return { ok: true, keys, values };
}

async function decideKey(adminId, keyId, decision, rejectReason, { req } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  if (!['accept', 'reject'].includes(decision)) return fail('invalid', "decision must be 'accept' or 'reject'");
  const key = await RegistryDataKey.findOneAndUpdate(
    { _id: { $eq: String(keyId) }, status: 'proposed' },
    {
      $set: {
        status: decision === 'accept' ? 'accepted' : 'rejected',
        decidedBy: adminId,
        decidedAt: new Date(),
        ...(decision === 'reject' && rejectReason ? { rejectReason: stripHtml(String(rejectReason)).slice(0, 500) } : {}),
      },
    },
    { new: true }
  );
  if (!key) return fail('not_found', 'No proposed key with that id (already decided?)');
  logAudit(req || null, `registry_data.key_${decision}`,
    { type: 'registry_key', id: key._id }, { name: key.name });
  return { ok: true, key: serializeKey(key) };
}

async function decideValue(adminId, valueId, decision, rejectReason, { req } = {}) {
  if (!isValidId(String(valueId))) return fail('invalid', 'Invalid value id');
  if (!['publish', 'reject'].includes(decision)) return fail('invalid', "decision must be 'publish' or 'reject'");

  const row = await RegistryDataValue.findOne({ _id: { $eq: String(valueId) }, status: 'suggested' })
    .populate('key');
  if (!row) return fail('not_found', 'No suggested value with that id (already decided?)');

  if (decision === 'reject') {
    row.status = 'rejected';
    row.decidedBy = adminId;
    row.decidedAt = new Date();
    if (rejectReason) row.rejectReason = stripHtml(String(rejectReason)).slice(0, 500);
    await row.save();
    logAudit(req || null, 'registry_data.value_reject',
      { type: 'wine', id: row.wineDefinition }, { key: row.key?.name, valueId: row._id });
    return { ok: true, value: { _id: row._id, status: row.status } };
  }

  // Publishing supersedes any existing published value for (wine, key): the
  // old row is removed (history lives in the audit log), then this row takes
  // the published slot — the partial unique index allows exactly one.
  await RegistryDataValue.deleteOne({
    wineDefinition: row.wineDefinition, key: row.key._id, status: 'published',
  });
  row.status = 'published';
  row.decidedBy = adminId;
  row.decidedAt = new Date();
  await row.save();
  logAudit(req || null, 'registry_data.value_publish',
    { type: 'wine', id: row.wineDefinition }, { key: row.key?.name, valueId: row._id, value: row.value });
  return { ok: true, value: { _id: row._id, status: row.status, value: row.value } };
}

module.exports = {
  RESERVED_NAMES,
  proposeKey,
  listAcceptedKeys,
  suggestValue,
  dataForWine,
  listReviewQueues,
  decideKey,
  decideValue,
};
