/**
 * Contributing wines created on a self-hosted install to the shared registry
 * (Registry Bridge), install side. The registry side is
 * services/registryContributionIntake.js.
 *
 * Opt-in: nothing is offered unless an admin of this install asks, for one
 * wine or for every wine made here. A contribution carries the identity this
 * install holds, the wine's picture (re-encoded, metadata stripped) and the
 * drink windows reviewed here. On cellarion.app it waits in the wine-request
 * queue until it is approved, adjusted to the registry's rules on the way, or
 * declined; its windows go to the maturity queue there as suggestions. On
 * approval the wine HERE is linked to the registry wine
 * (registryBridge.linkContributedWine) rather than copied beside it, so its
 * bottles stay where they are and later corrections flow up like any copy's.
 *
 * Each contribution spends one unit of the key's daily `contributions`
 * quota, which this install's wine requests and corrections share. Sending
 * stops QUOTA_RESERVE short of the cap instead of running into the 429: that
 * answer makes the client back off from EVERY bridge call for minutes,
 * add-bottle search included. What does not fit today stays queued for the
 * hourly run.
 *
 * Callers: routes/bridge.js (the wine page and Settings → Shared wine
 * registry) and the scheduler's hourly bridge job (syncContributions, then
 * sendQueued).
 */
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const bridge = require('./registryBridge');
const client = require('./registryBridgeClient');
const { checkWindow, PHASE_FIELDS } = require('./maturityOps');
const { logAudit, logger } = require('./audit');
const { isValidId } = require('../utils/validation');

// Units of the daily contributions quota left for this install's members'
// own requests and corrections.
const QUOTA_RESERVE = 10;
const SEND_BATCH_MAX = 50;
// == the cap of GET /v1/requests?ids=
const SYNC_BATCH_MAX = 50;
// One "contribute all" (or one list of ids) queues at most this many.
const QUEUE_MAX = 500;
const ATTENTION_MAX = 50;
// A send claimed this long ago without an answer ended with the process.
const SENDING_STALE_MS = 10 * 60 * 1000;
// == WINDOWS_MAX in services/registryContributionIntake
const WINDOWS_MAX = 30;
const GRAPES_MAX = 20;
const GRAPE_NAME_MAX = 80;
// Statuses a wine may be (re)offered from.
const REOFFERABLE = ['declined', 'failed'];
// Statuses an admin may take back: nothing of these is waiting on cellarion.app.
const WITHDRAWABLE = ['queued', 'declined', 'duplicate', 'failed'];
const UPLOAD_PATH = /^\/api\/uploads\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// A wine that may be offered: made on this install, complete, never linked
// to the registry. `registryId: null` matches a missing field too.
const OFFERABLE = Object.freeze({
  registryId: null,
  createdVia: { $ne: 'bridge' },
  pendingIdentity: { $ne: true },
  draft: { $ne: true },
  nonWine: { $ne: true },
  producer: { $nin: [null, ''] },
});
const NEVER_OFFERED = { registryContribution: { $exists: false } };
const OFFERABLE_AGAIN = { $or: [NEVER_OFFERED, { 'registryContribution.status': { $in: REOFFERABLE } }] };

const PHASE_WIRE = [['early', 'earlyFrom', 'earlyUntil'], ['peak', 'peakFrom', 'peakUntil'], ['late', 'lateFrom', 'lateUntil']];

/** $set for some fields of the contribution state, leaving the others. */
function stateSet(patch) {
  const set = {};
  for (const [k, v] of Object.entries(patch)) set[`registryContribution.${k}`] = v;
  return { $set: set };
}

/**
 * The drink windows reviewed here for the wine, in the shape GET /v1/wines/:id
 * serves: year vintages only, newest first, at most WINDOWS_MAX, each passing
 * the same check the registry applies. Rows still pending here are not
 * windows anyone set, and NV offsets do not travel.
 */
async function reviewedWindows(wineId) {
  const rows = await WineVintageProfile.find({ wineDefinition: wineId, status: 'reviewed', relative: { $ne: true } })
    .sort({ vintage: -1 }).lean();
  const out = [];
  for (const row of rows) {
    if (out.length >= WINDOWS_MAX) break;
    if (!/^\d{4}$/.test(String(row.vintage))) continue;
    const incoming = {};
    for (const f of PHASE_FIELDS) {
      if (Number.isInteger(row[f])) incoming[f] = row[f];
    }
    if (!Object.keys(incoming).length || !checkWindow({ vintage: row.vintage }, incoming).ok) continue;
    const win = { vintage: String(row.vintage) };
    for (const [phase, from, until] of PHASE_WIRE) {
      if (incoming[from] != null || incoming[until] != null) win[phase] = { from: incoming[from] ?? null, until: incoming[until] ?? null };
    }
    out.push(win);
  }
  return out;
}

/**
 * The wine's picture as it may leave the install: a link as it is; a file
 * uploaded here read from disk and re-encoded (registryBridge
 * encodeRequestImage drops every bit of metadata); null otherwise or when
 * the file cannot be read.
 */
async function outgoingPicture(image) {
  const img = typeof image === 'string' ? image : '';
  if (/^https?:\/\//i.test(img)) return img;
  if (!UPLOAD_PATH.test(img) || /\/\.\.?(?:\/|$)/.test(img)) return null;
  try {
    const fs = require('fs');
    const { safeUploadPath } = require('./imageProcessor');
    const buffer = await fs.promises.readFile(safeUploadPath(img.replace('/api/uploads/', '')));
    return await bridge.encodeRequestImage(buffer);
  } catch (err) {
    logger.warn({ err, image: img }, 'contribution picture not readable; sent without it');
    return null;
  }
}

/** What goes up for one wine (populated with country, region and grapes). */
async function contributionPayload(wine) {
  const payload = { name: wine.name, producer: wine.producer };
  if (wine.country?.name) payload.country = wine.country.name;
  if (wine.region?.name) payload.region = wine.region.name;
  if (wine.appellation) payload.appellation = wine.appellation;
  if (wine.type) payload.type = wine.type;
  const grapes = (wine.grapes || []).map((g) => g?.name).filter((n) => typeof n === 'string' && n && n.length <= GRAPE_NAME_MAX);
  if (grapes.length) payload.grapes = grapes.slice(0, GRAPES_MAX);
  const picture = await outgoingPicture(wine.image);
  if (picture) payload.image = picture;
  const windows = await reviewedWindows(wine._id);
  if (windows.length) payload.windows = windows;
  return payload;
}

/**
 * Offer wines to the shared registry: mark them queued, never sent twice.
 * `all` takes every wine that was never offered (admins, Settings);
 * otherwise `wineIds` (the wine page sends one), each of which may also be a
 * declined or failed one offered again. A wine already linked, a copy from
 * the registry, a pending or draft row, or one without a producer is
 * skipped. Audits bridge.contribution.queue per wine. Returns
 * { ok: true, queued, ids } | { ok: false, code: 'disabled' | 'invalid' }.
 * The caller then starts sendQueued.
 */
async function queueContributions({ wineIds, all = false, req, via = 'web' } = {}) {
  if (!bridge.isEnabled()) return { ok: false, code: 'disabled' };
  let filter;
  if (all) {
    filter = { ...OFFERABLE, ...NEVER_OFFERED };
  } else {
    const ids = [...new Set((Array.isArray(wineIds) ? wineIds : []).map(String))];
    if (!ids.length || ids.length > QUEUE_MAX || !ids.every(isValidId)) return { ok: false, code: 'invalid' };
    filter = { _id: { $in: ids }, ...OFFERABLE, ...OFFERABLE_AGAIN };
  }
  const wines = await WineDefinition.find(filter).select('_id name producer').sort({ createdAt: 1 }).limit(QUEUE_MAX).lean();
  if (!wines.length) return { ok: true, queued: 0, ids: [] };
  const queuedAt = new Date();
  const ids = wines.map((w) => w._id);
  // The same filter again: a wine linked or offered between the read and
  // this write stays as it is.
  await WineDefinition.updateMany({ ...filter, _id: { $in: ids } }, {
    $set: { registryContribution: { status: 'queued', queuedAt } },
  });
  const queued = await WineDefinition.find({ _id: { $in: ids }, 'registryContribution.status': 'queued', 'registryContribution.queuedAt': queuedAt })
    .select('_id').lean();
  const queuedIds = new Set(queued.map((w) => String(w._id)));
  for (const w of wines) {
    if (!queuedIds.has(String(w._id))) continue;
    logAudit(req, 'bridge.contribution.queue', { type: 'wine', id: w._id }, { name: w.name, producer: w.producer, via, ...(all ? { all: true } : {}) });
  }
  return { ok: true, queued: queuedIds.size, ids: [...queuedIds] };
}

let sending = false;

/**
 * Send queued wines, oldest first, as far as today's contributions quota
 * allows (less QUOTA_RESERVE) and at most `max`. One run at a time per
 * process; a claim left by a run that died goes back to the queue. A wine
 * the registry refuses as sent is marked failed with its words; an
 * unreachable registry, a spent quota or a registry without the route puts
 * the wine back and ends the run. `ids` limits the run to those wines (the
 * wine page sends its own one at once). Callers: routes/bridge.js after
 * queueing, and the hourly scheduler job. Returns { sent, failed } or
 * { skipped }.
 */
async function sendQueued({ max = SEND_BATCH_MAX, ids = null } = {}) {
  if (!bridge.isEnabled()) return { skipped: 'disabled' };
  if (sending) return { skipped: 'running' };
  sending = true;
  try {
    // A queued wine that got linked another way meanwhile (an adoption by the
    // same identity) has nothing left to offer.
    await WineDefinition.updateMany({ 'registryContribution.status': 'queued', registryId: { $nin: [null, ''] } }, { $unset: { registryContribution: 1 } });
    await WineDefinition.updateMany(
      { 'registryContribution.status': 'sending', 'registryContribution.sentAt': { $lt: new Date(Date.now() - SENDING_STALE_MS) } },
      stateSet({ status: 'queued', sentAt: null })
    );
    const only = Array.isArray(ids) ? { _id: { $in: ids.filter(isValidId).map(String) } } : {};
    if (!(await WineDefinition.exists({ ...OFFERABLE, ...only, 'registryContribution.status': 'queued' }))) return { sent: 0, failed: 0 };

    const me = await client.me();
    if (!me) return { skipped: 'unreachable' };
    const used = Number(me.usage?.used?.contributions) || 0;
    const cap = Number(me.usage?.caps?.contributions ?? me.quotas?.contributions) || 0;
    let budget = Math.min(max, cap - used - QUOTA_RESERVE);
    if (budget <= 0) return { skipped: 'quota' };

    let sent = 0; let failed = 0;
    while (budget > 0) {
      const wine = await WineDefinition.findOneAndUpdate(
        { ...OFFERABLE, ...only, 'registryContribution.status': 'queued' },
        stateSet({ status: 'sending', sentAt: new Date() }),
        { sort: { 'registryContribution.queuedAt': 1, _id: 1 }, new: true }
      ).populate('country region grapes');
      if (!wine) break;
      budget--;
      const outcome = await sendOne(wine);
      if (outcome === 'sent') sent++;
      else if (outcome === 'failed') failed++;
      else break;
    }
    if (sent || failed) logger.info({ sent, failed }, '[bridge] contributions sent');
    return { sent, failed };
  } finally {
    sending = false;
  }
}

/** One claimed wine to the registry: 'sent' | 'failed' | 'stop'. */
async function sendOne(wine) {
  try {
    const payload = await contributionPayload(wine);
    let r = await client.forwardContribution(payload);
    // A body too large for the registry still goes, without the picture.
    if (r && !r.ok && r.status === 413 && payload.image) {
      const { image: _dropped, ...withoutPicture } = payload;
      r = await client.forwardContribution(withoutPicture);
    }
    const requestId = r && r.ok ? String(r.body?.request?.id || '') : '';
    if (isValidId(requestId)) {
      await WineDefinition.updateOne({ _id: wine._id }, stateSet({ status: 'sent', requestId, sentAt: new Date(), notes: null, decidedAt: null }));
      logAudit(null, 'bridge.contribution.sent', { type: 'wine', id: wine._id },
        { registryRequestId: requestId, windows: payload.windows?.length || 0, picture: !!payload.image, reused: !!r.body?.request?.reused });
      return 'sent';
    }
    if (r && !r.ok && (r.status === 400 || r.status === 413)) {
      await WineDefinition.updateOne({ _id: wine._id }, stateSet({
        status: 'failed', notes: String(r.message || 'The shared registry refused this wine as sent.').slice(0, 2000), decidedAt: new Date(),
      }));
      logAudit(null, 'bridge.contribution.failed', { type: 'wine', id: wine._id }, { status: r.status, message: r.message || null });
      return 'failed';
    }
    await WineDefinition.updateOne({ _id: wine._id }, stateSet({ status: 'queued', sentAt: null }));
    return 'stop';
  } catch (err) {
    logger.warn({ err, wineId: String(wine._id) }, '[bridge] contribution send failed; back in the queue');
    await WineDefinition.updateOne({ _id: wine._id }, stateSet({ status: 'queued', sentAt: null }))
      .catch((e) => logger.warn({ err: e, wineId: String(wine._id) }, '[bridge] contribution not put back in the queue'));
    return 'stop';
  }
}

/**
 * Finish the contributions cellarion.app has answered: an approved one is
 * linked (registryBridge.linkContributedWine), or marked duplicate when this
 * install already holds the registry's copy; a declined one keeps the
 * registry's reason. Still waiting: asked again next run, oldest-checked
 * first. Run hourly by the scheduler. Returns counts.
 */
async function syncContributions({ now = new Date() } = {}) {
  if (!bridge.isEnabled()) return { skipped: 'disabled' };
  const waiting = await WineDefinition.find({ 'registryContribution.status': 'sent', 'registryContribution.requestId': { $type: 'string' } })
    .select('_id registryContribution')
    .sort({ 'registryContribution.checkedAt': 1, 'registryContribution.sentAt': 1 })
    .limit(SYNC_BATCH_MAX).lean();
  const counts = { checked: waiting.length, linked: 0, declined: 0, duplicates: 0, failures: 0 };
  if (!waiting.length) return counts;
  const answers = await client.requestStatuses(waiting.map((w) => w.registryContribution.requestId));
  if (answers === null) return { ...counts, checked: 0, failed: true };
  const byId = new Map(answers.map((a) => [String(a.id), a]));
  const stamp = (w) => WineDefinition.updateOne({ _id: w._id, 'registryContribution.status': 'sent' }, stateSet({ checkedAt: now }))
    .catch((err) => logger.warn({ err, wineId: String(w._id) }, '[bridge] contribution check not stamped'));

  for (const w of waiting) {
    const requestId = w.registryContribution.requestId;
    const a = byId.get(requestId);
    try {
      if (a && a.status === 'resolved' && a.wine && isValidId(a.wine.id)) {
        const linked = await bridge.linkContributedWine(w._id, a.wine.id);
        if (linked.ok) {
          counts.linked++;
          logAudit(null, 'bridge.contribution.linked', { type: 'wine', id: w._id }, { registryId: String(a.wine.id), registryRequestId: requestId });
          continue;
        }
        if (linked.code === 'duplicate') {
          counts.duplicates++;
          await WineDefinition.updateOne({ _id: w._id }, stateSet({ status: 'duplicate', approvedRegistryId: String(a.wine.id), decidedAt: now, checkedAt: now }));
          logAudit(null, 'bridge.contribution.duplicate', { type: 'wine', id: w._id }, { registryId: String(a.wine.id), duplicateOf: String(linked.heldId) });
          continue;
        }
        if (linked.code === 'conflict') {
          // Linked to another registry wine meanwhile: nothing left to finish.
          await WineDefinition.updateOne({ _id: w._id }, { $unset: { registryContribution: 1 } });
          continue;
        }
        if (linked.code === 'gone') continue;
        counts.failures++;
        await stamp(w);
        continue;
      }
      if (a && a.status === 'rejected') {
        counts.declined++;
        await WineDefinition.updateOne({ _id: w._id }, stateSet({
          status: 'declined', notes: String(a.notes || 'Declined by the shared registry on cellarion.app.').slice(0, 2000), decidedAt: now, checkedAt: now,
        }));
        logAudit(null, 'bridge.contribution.declined', { type: 'wine', id: w._id }, { registryRequestId: requestId });
        continue;
      }
      await stamp(w);
    } catch (err) {
      counts.failures++;
      logger.warn({ err, wineId: String(w._id) }, '[bridge] contribution sync failed for one wine');
      await stamp(w);
    }
  }
  if (counts.linked || counts.declined || counts.duplicates || counts.failures) {
    logger.info(counts, '[bridge] contribution sync');
  }
  return counts;
}

/**
 * Take back an offer that is not waiting on cellarion.app (queued, declined,
 * duplicate or failed). One already sent is the registry's to answer.
 * Returns { ok: true } | { ok: false, code: 'invalid' | 'not_found' | 'sent' }.
 */
async function withdrawContribution({ wineId, req, via = 'web' } = {}) {
  if (!isValidId(wineId)) return { ok: false, code: 'invalid' };
  const res = await WineDefinition.updateOne(
    { _id: { $eq: String(wineId) }, 'registryContribution.status': { $in: WITHDRAWABLE } },
    { $unset: { registryContribution: 1 } }
  );
  if (!res.modifiedCount) {
    const wine = await WineDefinition.findOne({ _id: { $eq: String(wineId) } }).select('registryContribution').lean();
    return { ok: false, code: wine?.registryContribution ? 'sent' : 'not_found' };
  }
  logAudit(req, 'bridge.contribution.withdraw', { type: 'wine', id: wineId }, { via });
  return { ok: true };
}

/**
 * The state shown to a person: no request ids, nothing internal. duplicateOf
 * is the wine HERE that holds the registry wine a duplicate was approved as,
 * looked up now (copies: registry id → local id), so it follows merges.
 */
function stateOut(c, copies = new Map()) {
  if (!c) return null;
  return {
    status: c.status === 'sending' ? 'queued' : c.status,
    queuedAt: c.queuedAt || null,
    sentAt: c.status === 'sent' ? c.sentAt || null : null,
    decidedAt: c.decidedAt || null,
    notes: c.notes || null,
    duplicateOf: c.status === 'duplicate' && c.approvedRegistryId ? copies.get(c.approvedRegistryId) || null : null,
  };
}

/** registry id → the id of the local wine holding it, for these ids. */
async function localCopies(registryIds) {
  const ids = [...new Set(registryIds.filter(isValidId).map(String))];
  if (!ids.length) return new Map();
  const rows = await WineDefinition.find({ registryId: { $in: ids } }).select('_id registryId').lean();
  return new Map(rows.map((r) => [r.registryId, String(r._id)]));
}

/**
 * One wine, for its page: whether the bridge is on, whether the wine may be
 * offered now, and its contribution state. The caller has checked the viewer
 * may see the wine.
 */
async function contributionForWine(wineId) {
  if (!bridge.isEnabled()) return { enabled: false };
  const wine = await WineDefinition.findOne({ _id: { $eq: String(wineId) } }).select('registryId registryContribution').lean();
  if (!wine) return null;
  const offerable = !!(await WineDefinition.exists({ _id: wine._id, ...OFFERABLE, ...OFFERABLE_AGAIN }));
  const copies = await localCopies([wine.registryContribution?.approvedRegistryId].filter(Boolean));
  return { enabled: true, linked: !!wine.registryId, offerable, contribution: stateOut(wine.registryContribution, copies) };
}

/**
 * The whole install, for Settings: how many wines made here were never
 * offered, how many sit in each state, and the ones that need a person
 * (declined, duplicate, failed), most recent first.
 */
async function contributionOverview() {
  if (!bridge.isEnabled()) return { enabled: false };
  const [offerable, groups, attention] = await Promise.all([
    WineDefinition.countDocuments({ ...OFFERABLE, ...NEVER_OFFERED }),
    WineDefinition.aggregate([
      { $match: { 'registryContribution.status': { $exists: true } } },
      { $group: { _id: '$registryContribution.status', n: { $sum: 1 } } },
    ]),
    WineDefinition.find({ 'registryContribution.status': { $in: ['declined', 'duplicate', 'failed'] } })
      .select('name producer slug registryContribution')
      .sort({ 'registryContribution.decidedAt': -1 }).limit(ATTENTION_MAX).lean(),
  ]);
  const copies = await localCopies(attention.map((w) => w.registryContribution?.approvedRegistryId).filter(Boolean));
  const counts = { queued: 0, sent: 0, declined: 0, duplicate: 0, failed: 0 };
  for (const g of groups) {
    const key = g._id === 'sending' ? 'queued' : g._id;
    if (key in counts) counts[key] += g.n;
  }
  return {
    enabled: true,
    offerable,
    counts,
    attention: attention.map((w) => ({ id: String(w._id), name: w.name, producer: w.producer, slug: w.slug || null, ...stateOut(w.registryContribution, copies) })),
  };
}

function _reset() { sending = false; }

module.exports = {
  queueContributions, sendQueued, syncContributions, withdrawContribution, contributionForWine, contributionOverview,
  contributionPayload, reviewedWindows, OFFERABLE, QUOTA_RESERVE, QUEUE_MAX, _reset,
};
