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
 * message } — codes: invalid | banned | limit | not_found | conflict | in_use.
 */
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const { originFrom } = require('../utils/contributionOrigin');
const { findVisibleWine } = require('./wineVisibility');
const { validateValue, validateKeyDefinition } = require('../utils/personalDataTypes');
const { checkContributionGate } = require('./contributionGate');
const { appliesDirectly } = require('./trustedContributions');
const { stripHtml } = require('../utils/sanitize');
const { isValidId, parseAndValidateVintage } = require('../utils/validation');
const { localizedName, sanitizeTranslations } = require('../utils/localizedName');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');
const { awardValue, SUPERSEDED_REASON } = require('./suggestionCred');
const { matchKeyByName } = require('../utils/registryKeyName');

// Names that would shadow first-class record fields — a key called
// "producer" or "region" must never exist beside the real thing.
const RESERVED_NAMES = [
  'producer', 'name', 'appellation', 'region', 'country', 'classification',
  'type', 'grapes', 'vintage', 'body', 'tannin', 'acidity', 'sweetness',
  'flavors', 'flavours', 'description', 'rating', 'price',
  // The label sweetness term is a first-class field of the wine record
  // (WineDefinition.labelSweetness): no data field may shadow it.
  'label sweetness', 'labelsweetness',
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

// A Mongoose document holds a Map, a .lean() row a plain object, and an
// untranslated key nothing at all — one plain object (or null) on the wire.
const plainTranslations = (k) => {
  const t = k && k.translations;
  if (!t) return null;
  const obj = typeof t.get === 'function' ? Object.fromEntries(t) : { ...t };
  return Object.keys(obj).length ? obj : null;
};

const serializeKey = (k, locale) => ({
  _id: k._id,
  name: k.name,
  // What to SHOW this reader: the translation for their language when there
  // is one, else the canonical name. `name` stays the identifier everywhere —
  // suggestions, MCP arguments and analytics all key on it.
  displayName: localizedName(k, locale),
  type: k.type,
  unit: k.unit || null,
  enumOptions: k.enumOptions || null,
  status: k.status,
  translations: plainTranslations(k),
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

  // No daily limit where nobody reviews (services/trustedContributions).
  const gate = await checkContributionGate(userId, { budget: !appliesDirectly(via) });
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
  // A server that does not review accepts it as proposed, decided by its proposer.
  if (appliesDirectly(via)) {
    const decided = await decideKey(userId, key._id, 'accept', null, { req, notify: false });
    if (decided.ok) return { ok: true, key: decided.key, applied: true };
  }
  return { ok: true, key: serializeKey(key) };
}

/** The accepted vocabulary (for pickers and the wine-record display). */
async function listAcceptedKeys({ locale } = {}) {
  const keys = await acceptedKeys();
  return { ok: true, keys: keys.map((k) => serializeKey(k, locale)) };
}

/**
 * The ACCEPTED key a member's name for it means, or null. The exact name
 * comes first (indexed); otherwise the cached vocabulary is matched on the
 * canonical name and every translation, ignoring case, accents and
 * punctuation (utils/registryKeyName) — "Alkoholhalt" is ABV. A proposed or
 * rejected key never matches: values are filed against accepted keys only.
 */
async function findAcceptedKeyByName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const exact = await RegistryDataKey.findOne({
    nameKey: { $eq: name.trim().toLowerCase() },
    status: 'accepted',
  });
  if (exact) return exact;
  return matchKeyByName(await acceptedKeys(), name);
}

/**
 * Suggest a value for an ACCEPTED key on a visible wine. The key may be
 * addressed by id (keyId) or by NAME (keyName — the promotion path from a
 * personal entry resolves server-side through findAcceptedKeyByName, so
 * clients never duplicate the matching rule).
 *
 * `vintage` picks the slot: omitted/blank = the wine-wide default, 'YYYY' =
 * an override for that bottling only. A figure read off a label or a
 * retailer page for one year belongs in the vintage slot; the producer's
 * general spec belongs in the default.
 */
async function suggestValue(userId, { wineId, keyId, keyName, value, reason, evidenceUrl, vintage }, { via, req } = {}) {
  const origin = originFrom(req, via);
  let key;
  if (keyId) {
    if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
    key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: 'accepted' });
  } else if (typeof keyName === 'string' && keyName.trim()) {
    key = await findAcceptedKeyByName(keyName);
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

  // No daily limit where nobody reviews (services/trustedContributions).
  const gate = await checkContributionGate(userId, { budget: !appliesDirectly(via) });
  if (!gate.ok) return gate;

  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  // noDrafts: public registry data is written against published wines only.
  const wine = await findVisibleWine(String(wineId), { userId, roles: req?.user?.roles || [], noDrafts: true });
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
      ...origin,
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
  // A server that does not review publishes it as suggested, decided by its suggester.
  if (appliesDirectly(via)) {
    const decided = await decideValue(userId, row._id, 'publish', null, { req, notify: false });
    if (decided.ok) {
      return {
        ok: true,
        applied: true,
        value: { _id: row._id, key: serializeKey(key), value: row.value, vintage: slot.value, status: 'published' },
      };
    }
  }
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
async function dataForWine(wineId, userId = null, { roles, vintage, locale } = {}) {
  if (!isValidId(String(wineId))) return fail('invalid', 'Invalid wine id');
  const wine = await findVisibleWine(String(wineId), { userId, roles: roles || [], noDrafts: true });
  if (!wine) return fail('not_found', 'Wine not found');
  const wid = String(wine._id);

  // The bottle's vintage, when the caller has one: picks which override
  // resolves and which slot a new suggestion would land in. A malformed or
  // NV/Unknown vintage simply reads the default.
  const asked = normaliseVintage(vintage);
  const forVintage = asked.ok ? asked.value : null;

  const keys = await acceptedKeys();
  if (keys.length === 0) return { ok: true, fields: [], vintage: forVintage };

  // WHO contributed a published value stays on the row (`suggestedBy` — the
  // admin queues, the audit trail and the contributor's own export read it) and
  // goes no further: this function feeds every user-facing surface (the bottle
  // page, the connector), and none of them names the contributor (Johan,
  // 2026-09-18 — the record is the registry's, not a byline; same rule as a
  // correction's proposer, #930). So it is not even loaded here.
  const [publishedRows, pendingRows] = await Promise.all([
    RegistryDataValue.find({ wineDefinition: { $eq: wid }, status: 'published' })
      .select('key value vintage').lean(),
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
        key: serializeKey(k, locale),
        value: pub ? pub.value : null,
        // 'vintage' = an override for the asked vintage; 'wine' = the
        // wine-wide default; null = blank. The UI tags the value with it.
        resolvedFrom: from,
        resolvedVintage: from === 'vintage' ? pub.vintage : null,
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

async function decideKey(adminId, keyId, decision, rejectReason, { req, notify = true } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  if (!['accept', 'reject'].includes(decision)) return fail('invalid', "decision must be 'accept' or 'reject'");
  const key = await RegistryDataKey.findOneAndUpdate(
    { _id: { $eq: String(keyId) }, status: 'proposed' },
    {
      $set: {
        status: decision === 'accept' ? 'accepted' : 'rejected',
        decidedBy: adminId,
        decidedAt: new Date(),
        ...(decision === 'reject' && rejectReason ? { rejectReason: stripHtml(String(rejectReason)).slice(0, 2000) } : {}),
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
  // recorded decision. notify:false = accepted as proposed on a server that
  // does not review (services/trustedContributions).
  if (notify) notifyDecision(
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
async function decideValue(adminId, valueId, decision, rejectReason, { req, asWineDefault = false, notify = true } = {}) {
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
    if (rejectReason) row.rejectReason = stripHtml(String(rejectReason)).slice(0, 2000);
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
  // the partial unique index keeps singular. The demoted row keeps its
  // suggester's Cellar Cred (services/suggestionCred reads SUPERSEDED_REASON).
  const widened = !!asWineDefault && !!row.vintage;
  const targetVintage = asWineDefault ? null : (row.vintage || null);
  const suggestedFor = row.vintage || null;
  await RegistryDataValue.updateOne(
    { wineDefinition: row.wineDefinition, key: row.key._id, vintage: targetVintage, status: 'published' },
    { $set: { status: 'rejected', rejectReason: SUPERSEDED_REASON, decidedBy: adminId, decidedAt: new Date() } }
  );
  row.vintage = targetVintage;
  row.status = 'published';
  row.decidedBy = adminId;
  row.decidedAt = new Date();
  await row.save();
  logAudit(req || null, 'registry_data.value_publish',
    { type: 'wine', id: row.wineDefinition },
    { key: row.key?.name, valueId: row._id, value: row.value, vintage: targetVintage, ...(widened ? { widenedFrom: suggestedFor } : {}) });
  // Published: the suggester's Cellar Cred, once per row — never for a
  // curator's own value or a staff account's. Never throws.
  await awardValue(row);
  const where = targetVintage
    ? `on the ${targetVintage} vintage`
    : (widened ? `on the wine for every vintage (a curator judged your ${suggestedFor} figure to be the producer's general spec)` : 'on the wine');
  if (notify) notifyDecision(
    row.suggestedBy,
    'registry_value_decided',
    'Suggested value published',
    `Your suggested ${row.key?.name || 'value'} (${row.value}) is now published ${where}. Thank you for improving the registry.`
  );
  return { ok: true, value: { _id: row._id, status: row.status, value: row.value, vintage: targetVintage } };
}

/**
 * Replace a key's display-name translations (admin).
 *
 * A full replacement, not a merge, for the same reason as the taxonomy
 * editor: a language absent from the body is REMOVED, and that is the only
 * shape in which a wrong translation can be deleted. English is refused by
 * sanitizeTranslations — the canonical `name` is the English.
 *
 * Proposed keys may be translated too (a curator can prepare one before
 * accepting it); rejected ones cannot, they are tombstones.
 */
async function setKeyTranslations(adminId, keyId, translations, { req } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  // Same ceiling as the key name itself.
  const parsed = sanitizeTranslations(translations, 60);
  if (!parsed.ok) return fail('invalid', parsed.error);

  const key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: { $ne: 'rejected' } });
  if (!key) return fail('not_found', 'No live key with that id');

  const before = plainTranslations(key) || {};
  const languages = Object.keys(parsed.translations);
  // undefined, not an empty Map: the field's default is undefined, and an
  // empty Map on every untranslated key would be litter.
  key.translations = languages.length ? parsed.translations : undefined;
  await key.save();
  invalidateVocabCache();

  logAudit(req || null, 'registry_data.key_translations',
    { type: 'registry_key', id: key._id }, { name: key.name, before, after: parsed.translations });
  return { ok: true, key: serializeKey(key) };
}

/* ── Changing the vocabulary itself ──────────────────────────────────── */

// The rows a key definition governs: what waits and what wine records show.
// A rejected row is history (a declined or superseded value) and keeps the
// form it was stored in.
const LIVE_VALUES = ['suggested', 'published'];
// What a key taken out of the vocabulary, and each value it held, is marked
// with — a tombstone, never a deletion.
const KEY_REMOVED_REASON = 'Removed from the vocabulary by an admin';
const FIELD_REMOVED_REASON = 'Removed together with its field';

/**
 * A stored value read under a (new) definition: the ordinary entry rules,
 * plus one allowance for a number first stored as text with the field's
 * unit written after it ("13.5 %", "13,5%" on an ABV field created as text).
 */
function castForKey(def, raw) {
  const out = validateValue(def, raw);
  if (out.ok || !def.unit || !['integer', 'decimal'].includes(def.type) || typeof raw !== 'string') return out;
  const s = raw.trim();
  if (!s.toLowerCase().endsWith(def.unit.toLowerCase())) return out;
  const bare = s.slice(0, s.length - def.unit.length).trim();
  return bare ? validateValue(def, bare) : out;
}

/**
 * Change a key's type, unit or allowed values (admin) — a field created the
 * wrong way (ABV as text, discussion #1778) had no way back. Accepted and
 * still-proposed keys alike; the name stays (it is the identifier), and so
 * does the id, so analytics fields and saved views keep pointing at it.
 *
 * Every live value is read again under the new definition. When they all
 * fit, they are stored in the new form together with the key; when any does
 * not, nothing changes and the answer names the values to correct first.
 * Returns the previous definition beside the new one.
 */
async function updateKey(adminId, keyId, { type, unit, enumOptions } = {}, { req } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  if (type === undefined && unit === undefined && enumOptions === undefined) {
    return fail('invalid', 'Nothing to change — pass type, unit and/or enumOptions');
  }
  const key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: { $in: ['proposed', 'accepted'] } });
  if (!key) return fail('not_found', 'No live key with that id');

  // What is not passed stays; validateKeyDefinition drops a unit or a list
  // the new type does not carry.
  const checked = validateKeyDefinition({
    name: key.name,
    type: type !== undefined ? type : key.type,
    unit: unit !== undefined ? unit : key.unit,
    enumOptions: enumOptions !== undefined ? enumOptions : key.enumOptions,
  });
  if (!checked.ok) return fail('invalid', checked.error);
  const def = checked.def;
  const definitionOf = (d) => ({ type: d.type, unit: d.unit || null, enumOptions: d.enumOptions?.length ? [...d.enumOptions] : null });
  const before = definitionOf(key);
  const after = definitionOf(def);
  if (JSON.stringify(before) === JSON.stringify(after)) return fail('invalid', `"${key.name}" is already defined that way`);

  const rows = await RegistryDataValue.find({ key: key._id, status: { $in: LIVE_VALUES } })
    .select('value wineDefinition vintage').lean();
  const misfits = [];
  const changes = [];
  for (const r of rows) {
    const cast = castForKey(def, r.value);
    if (!cast.ok) misfits.push(r);
    else if (cast.value !== r.value) changes.push({ _id: r._id, value: cast.value });
  }
  if (misfits.length) {
    const WineDefinition = require('../models/WineDefinition');
    const shown = misfits.slice(0, 5);
    const wines = await WineDefinition.find({ _id: { $in: shown.map((r) => r.wineDefinition) } }).select('name producer').lean();
    const label = new Map(wines.map((w) => [String(w._id), [w.producer, w.name].filter(Boolean).join(' — ')]));
    const named = shown.map((r) => `"${r.value}" on ${label.get(String(r.wineDefinition)) || 'a wine'}${r.vintage ? ` ${r.vintage}` : ''}`);
    const more = misfits.length > shown.length ? ` and ${misfits.length - shown.length} more` : '';
    const one = misfits.length === 1;
    return fail('in_use',
      `${misfits.length} value${one ? '' : 's'} of "${key.name}" ${one ? 'does' : 'do'} not fit a ${def.type} field: ${named.join(', ')}${more}. ` +
      `Correct ${one ? 'it' : 'them'} on the wine first (a newer value replaces the old one), then change the field.`);
  }

  if (changes.length) {
    const now = new Date();
    await RegistryDataValue.bulkWrite(changes.map((c) => ({
      updateOne: { filter: { _id: c._id }, update: { $set: { value: c.value, updatedAt: now } } },
    })));
  }
  key.type = def.type;
  key.unit = def.unit || undefined;
  key.enumOptions = def.enumOptions || undefined;
  await key.save();
  invalidateVocabCache();
  logAudit(req || null, 'registry_data.key_update',
    { type: 'registry_key', id: key._id }, { name: key.name, before, after, converted: changes.length });
  return { ok: true, key: serializeKey(key), prev: before, converted: changes.length };
}

/**
 * Take an accepted key out of the vocabulary (admin). It stays as a
 * tombstone — rejected, like a declined proposal — so the name is free for
 * a better-defined field, the standard-field seed (services/registryKeySeed)
 * leaves it alone, and every value that pointed at it still has its key.
 *
 * A key holding values is removed only with removeValues: its waiting
 * suggestions and published values are demoted with it (never deleted) and
 * wine records stop showing them. Suggesters keep their cred — what they
 * contributed was accepted (services/suggestionCred) — and whoever still
 * waited is told. A proposed key is rejected instead (decideKey).
 */
async function removeKey(adminId, keyId, { removeValues = false, req } = {}) {
  if (!isValidId(String(keyId))) return fail('invalid', 'Invalid key id');
  const key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) }, status: 'accepted' });
  if (!key) return fail('not_found', 'No accepted key with that id (a proposed one is rejected instead)');

  const [published, suggested] = await Promise.all([
    RegistryDataValue.countDocuments({ key: key._id, status: 'published' }),
    RegistryDataValue.countDocuments({ key: key._id, status: 'suggested' }),
  ]);
  if ((published || suggested) && removeValues !== true) {
    const held = [
      published ? `${published} published value${published === 1 ? '' : 's'}` : null,
      suggested ? `${suggested} waiting suggestion${suggested === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' and ');
    return fail('in_use', `"${key.name}" holds ${held}. Removing the field takes them off the wine records too.`);
  }

  const now = new Date();
  const waiting = suggested
    ? await RegistryDataValue.distinct('suggestedBy', { key: key._id, status: 'suggested' })
    : [];
  if (published || suggested) {
    await RegistryDataValue.updateMany(
      { key: key._id, status: { $in: LIVE_VALUES } },
      { $set: { status: 'rejected', rejectReason: FIELD_REMOVED_REASON, decidedBy: adminId, decidedAt: now, updatedAt: now } }
    );
  }
  key.status = 'rejected';
  key.rejectReason = KEY_REMOVED_REASON;
  key.decidedBy = adminId;
  key.decidedAt = now;
  await key.save();
  invalidateVocabCache();
  logAudit(req || null, 'registry_data.key_remove',
    { type: 'registry_key', id: key._id }, { name: key.name, published, suggested });
  for (const userId of waiting) {
    if (String(userId) === String(adminId)) continue;
    notifyDecision(userId, 'registry_value_decided', 'Suggested value not published',
      `Your suggested ${key.name} was not published: the field was removed from the registry.`);
  }
  return { ok: true, key: serializeKey(key), removed: { published, suggested } };
}

module.exports = {
  RESERVED_NAMES,
  REVIEW_QUEUE_LIMIT,
  proposeKey,
  listAcceptedKeys,
  findAcceptedKeyByName,
  suggestValue,
  dataForWine,
  listReviewQueues,
  decideKey,
  decideValue,
  setKeyTranslations,
  updateKey,
  removeKey,
  // Vintage-slot helpers — shared with the analytics query engine so a
  // bottle resolves its ABV by the same override → default rule everywhere.
  normaliseVintage,
  resolveForVintage,
  // exported for tests
  invalidateVocabCache,
};
