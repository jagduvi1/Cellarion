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
const { findVisibleWine } = require('./wineVisibility');
const { validateValue, validateKeyDefinition } = require('../utils/personalDataTypes');
const { checkContributionGate } = require('./contributionGate');
const { stripHtml } = require('../utils/sanitize');
const { isValidId, parseAndValidateVintage } = require('../utils/validation');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');

// Names that would shadow first-class record fields — a key called
// "producer" or "region" must never exist beside the real thing.
const RESERVED_NAMES = [
  'producer', 'name', 'appellation', 'region', 'country', 'classification',
  'type', 'grapes', 'vintage', 'body', 'tannin', 'acidity', 'sweetness',
  'flavors', 'flavours', 'description', 'rating', 'price',
];

const fail = (code, message) => ({ ok: false, code, message });

/**
 * The slot a value applies to: null = the wine-wide default, 'YYYY' = that
 * vintage only (2026-09-04, per-vintage overrides). Blank, 'all', NV and
 * Unknown all collapse to the default — an override records drift BETWEEN
 * years, and a bottle without a year has nothing to drift from. Anything
 * else must be a plausible year (same rule as Bottle.vintage).
 */
function normaliseVintage(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return { ok: true, value: null };
  const parsed = parseAndValidateVintage(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value === 'NV' || parsed.value === 'Unknown') return { ok: true, value: null };
  return { ok: true, value: parsed.value };
}

/**
 * Resolve the value a bottle of `vintage` sees from the published rows of
 * ONE key: the override for that exact vintage, else the wine-wide default,
 * else nothing. `rows` may mix keys; the caller filters. Returns
 * { row, from } where from ∈ 'vintage' | 'wine' | null.
 */
function resolveForVintage(rows, vintage) {
  let dflt = null;
  let exact = null;
  for (const r of rows) {
    const slot = r.vintage || null;
    if (slot === null) dflt = r;
    else if (vintage && slot === vintage) exact = r;
  }
  if (exact) return { row: exact, from: 'vintage' };
  if (dflt) return { row: dflt, from: 'wine' };
  return { row: null, from: null };
}

// The accepted vocabulary is global, tiny, and changes only on an admin
// decision — cache it in-process (audit: dataForWine rides the hottest page).
let vocabCache = null;
let vocabCacheAt = 0;
const VOCAB_TTL_MS = 60 * 1000;

async function acceptedKeys() {
  if (vocabCache && Date.now() - vocabCacheAt < VOCAB_TTL_MS) return vocabCache;
  vocabCache = await RegistryDataKey.find({ status: 'accepted' }).sort({ nameKey: 1 }).lean();
  vocabCacheAt = Date.now();
  return vocabCache;
}

function invalidateVocabCache() {
  vocabCache = null;
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

  const gate = await checkContributionGate(userId);
  if (!gate.ok) return gate;

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
  const keys = await acceptedKeys();
  return { ok: true, keys: keys.map(serializeKey) };
}

/**
 * Suggest a value for an ACCEPTED key on a visible wine. The key may be
 * addressed by id (keyId) or by NAME (keyName — the promotion path from a
 * personal entry resolves against nameKey server-side, so clients never
 * duplicate the matching rule).
 *
 * `vintage` picks the slot: omitted/blank = the wine-wide default, 'YYYY' =
 * an override for that bottling only. A figure read off a label or a
 * retailer page for one year belongs in the vintage slot; the producer's
 * general spec belongs in the default.
 */
async function suggestValue(userId, { wineId, keyId, keyName, value, reason, evidenceUrl, vintage }, { via, req } = {}) {
  let key;
  if (keyId) {
    if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
    key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: 'accepted' });
  } else if (typeof keyName === 'string' && keyName.trim()) {
    key = await RegistryDataKey.findOne({
      nameKey: { $eq: keyName.trim().toLowerCase() },
      status: 'accepted',
    });
  } else {
    return fail('invalid', 'Pass keyId or keyName');
  }
  if (!key) return fail('not_found', 'No such key in the accepted vocabulary');

  const checked = validateValue(key, value);
  if (!checked.ok) return fail('invalid', checked.error);

  const slot = normaliseVintage(vintage);
  if (!slot.ok) return fail('invalid', slot.error);

  let cleanUrl = '';
  if (evidenceUrl !== undefined && evidenceUrl !== null) {
    cleanUrl = String(evidenceUrl).trim();
    if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
      return fail('invalid', 'The evidence link must be an http:// or https:// URL.');
    }
    if (cleanUrl.length > 500) return fail('invalid', 'The evidence link must be at most 500 characters.');
  }
  const cleanReason = stripHtml(typeof reason === 'string' ? reason : '').trim().slice(0, 1000);

  const gate = await checkContributionGate(userId);
  if (!gate.ok) return gate;

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const wine = await findVisibleWine(String(wineId), { userId, roles: req?.user?.roles || [] });
  if (!wine) return fail('not_found', 'Wine not found');

  // Same-as-published is a no-op the suggester should hear about — checked
  // against the slot being filed into, and for an override also against the
  // default it would merely repeat (a 2023 row saying what every vintage
  // already says adds nothing but a review).
  const published = await RegistryDataValue.findOne({
    wineDefinition: wine._id, key: key._id, status: 'published', vintage: slot.value,
  });
  if (published && String(published.value) === String(checked.value)) {
    return fail('conflict', slot.value
      ? `The record already says exactly that for ${slot.value} — nothing to change.`
      : 'The record already says exactly that — nothing to change.');
  }
  if (slot.value) {
    const wineWide = await RegistryDataValue.findOne({
      wineDefinition: wine._id, key: key._id, status: 'published', vintage: null,
    });
    if (wineWide && String(wineWide.value) === String(checked.value)) {
      return fail('conflict', `The wine-wide value already says exactly that, and ${slot.value} inherits it — nothing to change.`);
    }
  }

  let row;
  try {
    row = await RegistryDataValue.create({
      wineDefinition: wine._id,
      key: key._id,
      vintage: slot.value,
      value: checked.value,
      suggestedBy: userId,
      ...(cleanUrl ? { evidenceUrl: cleanUrl } : {}),
      ...(cleanReason ? { reason: cleanReason } : {}),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return fail('conflict', slot.value
        ? `A ${slot.value} value for this field is already awaiting review — thank you, it is in the queue.`
        : 'A value for this field is already awaiting review — thank you, it is in the queue.');
    }
    throw err;
  }

  logAudit(req || null, 'registry_data.value_suggest',
    { type: 'wine', id: wine._id },
    { key: key.name, valueId: row._id, vintage: slot.value, ...(via ? { via } : {}) });
  return {
    ok: true,
    value: { _id: row._id, key: serializeKey(key), value: row.value, vintage: slot.value, status: row.status },
  };
}

/**
 * Everything the wine-record section needs for one wine: the accepted
 * vocabulary, published values, whether ANY suggestion occupies a key's
 * one-pending slot (audit: without this a second suggester dead-ends on a
 * 409 the UI could not predict), and the caller's own pending suggestion.
 *
 * Gated on wine VISIBILITY like every other registry surface — a hidden
 * pendingIdentity wine answers the same not_found a missing id does.
 */
async function dataForWine(wineId, userId = null, { roles, vintage } = {}) {
  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const wine = await findVisibleWine(String(wineId), { userId, roles: roles || [] });
  if (!wine) return fail('not_found', 'Wine not found');
  const wid = String(wine._id);

  // The bottle's vintage, when the caller has one: picks which override
  // resolves and which slot a new suggestion would land in. A malformed or
  // NV/Unknown vintage simply reads the default.
  const asked = normaliseVintage(vintage);
  const forVintage = asked.ok ? asked.value : null;

  const keys = await acceptedKeys();
  if (keys.length === 0) return { ok: true, fields: [], vintage: forVintage };

  const [publishedRows, pendingRows] = await Promise.all([
    RegistryDataValue.find({ wineDefinition: { $eq: wid }, status: 'published' })
      .populate('suggestedBy', 'username displayName').lean(),
    RegistryDataValue.find({ wineDefinition: { $eq: wid }, status: 'suggested' })
      .select('key value status suggestedBy createdAt vintage').lean(),
  ]);
  const pubByKey = new Map();
  for (const v of publishedRows) {
    const k = String(v.key);
    if (!pubByKey.has(k)) pubByKey.set(k, []);
    pubByKey.get(k).push(v);
  }
  const pendingByKey = new Map();
  for (const v of pendingRows) {
    const k = String(v.key);
    if (!pendingByKey.has(k)) pendingByKey.set(k, []);
    pendingByKey.get(k).push(v);
  }
  const slotOf = (r) => r.vintage || null;
  return {
    ok: true,
    vintage: forVintage,
    fields: keys.map((k) => {
      const pubs = pubByKey.get(String(k._id)) || [];
      const { row: pub, from } = resolveForVintage(pubs, forVintage);
      const dflt = pubs.find((r) => slotOf(r) === null) || null;
      const overrides = pubs.filter((r) => slotOf(r) !== null)
        .map((r) => ({ vintage: r.vintage, value: r.value }))
        .sort((a, b) => (a.vintage < b.vintage ? 1 : -1));
      const pendings = pendingByKey.get(String(k._id)) || [];
      // The slot a new suggestion from THIS caller would land in.
      const pendingHere = pendings.find((p) => slotOf(p) === forVintage) || null;
      const own = pendings.find((p) => userId && String(p.suggestedBy) === String(userId)) || null;
      return {
        key: serializeKey(k),
        value: pub ? pub.value : null,
        // 'vintage' = an override for the asked vintage; 'wine' = the
        // wine-wide default; null = blank. The UI tags the value with it.
        resolvedFrom: from,
        resolvedVintage: from === 'vintage' ? pub.vintage : null,
        contributedBy: pub
          ? (pub.suggestedBy?.displayName || pub.suggestedBy?.username || null)
          : null,
        wineValue: dflt ? dflt.value : null,
        overrides,
        // Someone's suggestion holds the slot (no attribution leaked) — the
        // UI shows "pending" instead of an Add button that can only 409.
        hasPendingSuggestion: !!pendingHere,
        hasPendingWineSuggestion: pendings.some((p) => slotOf(p) === null),
        mySuggestion: own ? { value: own.value, status: own.status, vintage: slotOf(own) } : null,
      };
    }),
  };
}

/* ── Admin operations ────────────────────────────────────────────────── */

// Review pages and the MCP review tool work oldest-first in bounded pages —
// an unbounded triple-populate find over a growing queue is how admin pages
// die (audit finding).
const REVIEW_QUEUE_LIMIT = 200;

async function listReviewQueues() {
  const [keys, values] = await Promise.all([
    RegistryDataKey.find({ status: 'proposed' }).sort({ createdAt: 1 }).limit(REVIEW_QUEUE_LIMIT)
      .populate('proposedBy', 'username displayName contribution.tier').lean(),
    RegistryDataValue.find({ status: 'suggested' }).sort({ createdAt: 1 }).limit(REVIEW_QUEUE_LIMIT)
      .populate('key')
      .populate('suggestedBy', 'username displayName contribution.tier')
      .populate('wineDefinition', 'name producer slug').lean(),
  ]);

  // For a vintage-slotted suggestion the reviewer needs to know whether the
  // wine has a default at all: with none, this first figure may deserve to
  // seed the default too (their call — "publish as wine default"); with one,
  // the card shows what the override diverges from. One indexed query for
  // the page, only when any row needs it.
  const idOf = (x) => String(x?._id || x);
  const vintageRows = values.filter((v) => v.vintage && v.wineDefinition && v.key);
  const defaults = new Map();
  if (vintageRows.length) {
    const pairs = vintageRows.map((v) => ({ wineDefinition: idOf(v.wineDefinition), key: idOf(v.key), vintage: null, status: 'published' }));
    const rows = await RegistryDataValue.find({ $or: pairs }).select('wineDefinition key value').lean();
    for (const r of rows) defaults.set(`${idOf(r.wineDefinition)}:${idOf(r.key)}`, r.value);
  }
  const decorated = values.map((v) => ({
    ...v,
    vintage: v.vintage || null,
    wineDefault: v.vintage ? (defaults.has(`${idOf(v.wineDefinition)}:${idOf(v.key)}`) ? defaults.get(`${idOf(v.wineDefinition)}:${idOf(v.key)}`) : null) : undefined,
  }));
  return { ok: true, keys, values: decorated };
}

/**
 * Notify a contributor that their registry-data submission was decided.
 *
 * The reason is APPENDED to the message rather than replacing it, so an
 * accept still reads well (no reason) and a reject carries the curator's
 * words verbatim — which is the whole point: the rejectReason field existed,
 * was written, capped at 500 chars, and had no reader.
 *
 * Fire-and-forget by construction: the decision is already persisted and
 * audit-logged when this runs, and a push/DB hiccup must not surface as a
 * failed decision to the admin (mirrors routes/admin/wineRequests).
 */
function notifyDecision(userId, type, title, message, reason) {
  if (!userId) return;
  const body = reason ? `${message}\n\n${reason}` : message;
  // No link: unlike a wine request (which has /wine-requests) a contributor
  // has no page listing their own registry-data proposals, so the message
  // has to stand alone — and a link to a non-existent route would just 404.
  createNotification(userId, type, title, body, null).catch((err) => {
    console.warn('[registryDataOps] decision notification failed (non-fatal):', err.message);
  });
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
  invalidateVocabCache();
  logAudit(req || null, `registry_data.key_${decision}`,
    { type: 'registry_key', id: key._id }, { name: key.name });

  // Tell the proposer. Without this the decision — and the rejectReason a
  // curator took the trouble to write — was reachable only through a GDPR
  // data export, so a contributor got silence either way. Fire-and-forget,
  // like every other notify call: a notification failure must never undo a
  // recorded decision.
  notifyDecision(
    key.proposedBy,
    'registry_key_decided',
    decision === 'accept' ? 'Registry key accepted' : 'Registry key not accepted',
    decision === 'accept'
      ? `Your proposed key "${key.name}" is now part of the registry vocabulary — wines can carry it from now on. Thank you for improving the registry.`
      : `Your proposed key "${key.name}" was not added to the registry vocabulary.`,
    key.rejectReason
  );

  return { ok: true, key: serializeKey(key) };
}

/**
 * Publish or reject one suggested value. `asWineDefault` re-slots a
 * vintage-specific suggestion into the wine-wide default before publishing —
 * the reviewer's call when the evidence is clearly a producer spec sheet and
 * the suggester just left the (safer) vintage default selected.
 */
async function decideValue(adminId, valueId, decision, rejectReason, { req, asWineDefault = false } = {}) {
  if (!isValidId(String(valueId))) return fail('invalid', 'Invalid value id');
  if (!['publish', 'reject'].includes(decision)) return fail('invalid', "decision must be 'publish' or 'reject'");

  const row = await RegistryDataValue.findOne({ _id: { $eq: String(valueId) }, status: 'suggested' })
    .populate('key');
  if (!row) return fail('not_found', 'No suggested value with that id (already decided?)');
  if (!row.key) return fail('invalid', 'This suggestion’s key no longer exists — reject it instead.');

  if (decision === 'reject') {
    row.status = 'rejected';
    row.decidedBy = adminId;
    row.decidedAt = new Date();
    if (rejectReason) row.rejectReason = stripHtml(String(rejectReason)).slice(0, 500);
    await row.save();
    logAudit(req || null, 'registry_data.value_reject',
      { type: 'wine', id: row.wineDefinition }, { key: row.key?.name, valueId: row._id });
    notifyDecision(
      row.suggestedBy,
      'registry_value_decided',
      'Suggested value not published',
      `Your suggested ${row.key?.name || 'value'} was not published to the registry.`,
      row.rejectReason
    );
    return { ok: true, value: { _id: row._id, status: row.status } };
  }

  // The slot this publishes into: the row's own, or the wine-wide default
  // when the reviewer widened it. Publishing supersedes ONLY the value in
  // that same slot — a new default never touches the per-vintage overrides
  // and an override never touches the default. The old row is DEMOTED to
  // rejected (not deleted — audit finding: a crash between two writes must
  // never destroy the only durable copy of a published value; a demoted row
  // can be re-published by hand), then this row takes the published slot
  // the partial unique index keeps singular.
  const widened = !!asWineDefault && !!row.vintage;
  const targetVintage = asWineDefault ? null : (row.vintage || null);
  const suggestedFor = row.vintage || null;
  await RegistryDataValue.updateOne(
    { wineDefinition: row.wineDefinition, key: row.key._id, vintage: targetVintage, status: 'published' },
    { $set: { status: 'rejected', rejectReason: 'Superseded by a newer approval', decidedBy: adminId, decidedAt: new Date() } }
  );
  row.vintage = targetVintage;
  row.status = 'published';
  row.decidedBy = adminId;
  row.decidedAt = new Date();
  await row.save();
  logAudit(req || null, 'registry_data.value_publish',
    { type: 'wine', id: row.wineDefinition },
    { key: row.key?.name, valueId: row._id, value: row.value, vintage: targetVintage, ...(widened ? { widenedFrom: suggestedFor } : {}) });
  const where = targetVintage
    ? `on the ${targetVintage} vintage`
    : (widened ? `on the wine for every vintage (a curator judged your ${suggestedFor} figure to be the producer's general spec)` : 'on the wine');
  notifyDecision(
    row.suggestedBy,
    'registry_value_decided',
    'Suggested value published',
    `Your suggested ${row.key?.name || 'value'} (${row.value}) is now published ${where}. Thank you for improving the registry.`
  );
  return { ok: true, value: { _id: row._id, status: row.status, value: row.value, vintage: targetVintage } };
}

module.exports = {
  RESERVED_NAMES,
  REVIEW_QUEUE_LIMIT,
  proposeKey,
  listAcceptedKeys,
  suggestValue,
  dataForWine,
  listReviewQueues,
  decideKey,
  decideValue,
  // Vintage-slot helpers — shared with the analytics query engine so a
  // bottle resolves its ABV by the same override → default rule everywhere.
  normaliseVintage,
  resolveForVintage,
  // exported for tests
  invalidateVocabCache,
};
