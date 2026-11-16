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
 * add-bottle search included. For the same reason the calls of one run are
 * spaced (CALL_PAUSE_MS, under the registry's per-minute burst limit) and a
 * sync links at most SYNC_LINK_MAX wines (each costs a `fetches` unit). What
 * does not fit stays queued for the next hourly run.
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
const { isValidId, parseAndValidateVintage } = require('../utils/validation');
const { isOwnUploadPath } = require('./accountOps');

// Units of the daily contributions quota left for this install's members'
// own requests and corrections.
const QUOTA_RESERVE = 10;
const SEND_BATCH_MAX = 50;
// == the cap of GET /v1/requests?ids=
const SYNC_BATCH_MAX = 50;
// Links per sync run: each fetches the registry wine.
const SYNC_LINK_MAX = 10;
// Between two registry calls of one run: under the burst limit of 60 a minute.
const CALL_PAUSE_MS = 1100;
// Sends without an answer before a wine is failed (see attempts).
const ATTEMPT_LIMIT = 5;
// Hourly checks without a usable answer before a sent offer is failed: two days.
const MISS_LIMIT = 48;
// One "contribute all" (or one list of ids) queues at most this many.
const QUEUE_MAX = 500;
const ATTENTION_MAX = 50;
// A send claimed this long ago without an answer ended with the process.
const SENDING_STALE_MS = 10 * 60 * 1000;
// == WINDOWS_MAX in services/registryContributionIntake
const WINDOWS_MAX = 30;
const GRAPES_MAX = 20;
const GRAPE_NAME_MAX = 80;
// Statuses a wine may be (re)offered from by hand.
const REOFFERABLE = ['declined', 'failed', 'withdrawn'];
// Statuses an admin may take back: nothing of these is waiting on cellarion.app.
const WITHDRAWABLE = ['queued', 'declined', 'duplicate', 'failed'];

const pause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

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
    const parsed = parseAndValidateVintage(row.vintage);
    if (!parsed.ok || !/^\d{4}$/.test(parsed.value)) continue;
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
 * The wine's picture as it may leave the install: a file uploaded here, read
 * from disk and re-encoded inline (registryBridge encodeRequestImage drops
 * every bit of metadata). A link is never sent (the registry takes inline
 * pictures only); null then, or when the file cannot be read.
 */
async function outgoingPicture(image) {
  const img = typeof image === 'string' ? image : '';
  if (!isOwnUploadPath(img)) return null;
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
  // ref: this install's id for the wine, so a resend answers the same request
  // and two wines sharing a name never share one.
  const payload = { ref: String(wine._id), name: wine.name, producer: wine.producer };
  if (wine.country?.name) payload.country = wine.country.name;
  if (wine.region?.name) payload.region = wine.region.name;
  if (wine.appellation) payload.appellation = wine.appellation;
  if (wine.type) payload.type = wine.type;
  // Shown to the curator, so the registry wine can carry them too: a link
  // keeps them here only while the registry wine has none of its own.
  const classes = (wine.classifications || []).map((c) => c?.name).filter(Boolean);
  const classification = classes.length ? classes.join(', ') : wine.classification;
  if (classification && classification.length <= 150) payload.classification = classification;
  if (wine.colour) payload.colour = wine.colour;
  if (wine.labelSweetness?.name) payload.sweetness = wine.labelSweetness.name;
  if (wine.lwin?.lwin7 && wine.lwin.lwin7.length <= 20) payload.lwin = wine.lwin.lwin7;
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
let syncing = false;

/**
 * What both runs start with: a claim left by a run that died goes back to the
 * queue, and an offer on a wine that got linked to the registry another way
 * meanwhile (an adoption by the same identity) is dropped, having nothing
 * left to do. A 'sent' one stays: with a registry id it is a link still being
 * finished (registryBridge.linkContributedWine).
 */
async function tidyStates() {
  await WineDefinition.updateMany(
    { 'registryContribution.status': { $exists: true, $ne: 'sent' }, registryId: { $nin: [null, ''] } },
    { $unset: { registryContribution: 1 } }
  );
  await WineDefinition.updateMany(
    { 'registryContribution.status': 'sending', 'registryContribution.sentAt': { $lt: new Date(Date.now() - SENDING_STALE_MS) } },
    stateSet({ status: 'queued', sentAt: null })
  );
}

/**
 * Send queued wines, oldest first, as far as today's contributions quota
 * allows (less QUOTA_RESERVE) and at most `max`, CALL_PAUSE_MS apart. One run
 * at a time per process. A wine the registry refuses as sent is marked failed
 * with its words; one that gets no answer goes to the back of the queue and
 * ends the run, and after ATTEMPT_LIMIT such tries it is failed instead of
 * holding the queue. `ids` limits the run to those wines (the wine page sends
 * its own one at once). Callers: routes/bridge.js after queueing, and the
 * hourly scheduler job. Returns { sent, failed } or { skipped }.
 */
async function sendQueued({ max = SEND_BATCH_MAX, ids = null, pauseMs = CALL_PAUSE_MS } = {}) {
  if (!bridge.isEnabled()) return { skipped: 'disabled' };
  if (sending) return { skipped: 'running' };
  sending = true;
  try {
    await tidyStates();
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
      ).populate('country region grapes classifications labelSweetness');
      if (!wine) break;
      if (sent + failed > 0) await pause(pauseMs);
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

/**
 * A claimed wine that got no answer: to the back of the queue, so it never
 * holds the front. A try that reached the registry and failed there (a 5xx, a
 * proxy's refusal, a timeout) counts; one the client never made (backing off,
 * the quota, a key refusal, a registry without the route) does not. After
 * ATTEMPT_LIMIT counted tries the wine is failed with the reason.
 */
async function giveBack(wine, r) {
  const counted = !!r && !(r.status === 429 || r.status === 401 || r.status === 404 || (r.status === 0 && r.code !== 'network'));
  const attempts = (wine.registryContribution?.attempts || 0) + (counted ? 1 : 0);
  const reason = r ? (r.status ? `HTTP ${r.status}` : r.code || 'no answer') : 'no answer';
  if (attempts >= ATTEMPT_LIMIT) {
    await WineDefinition.updateOne({ _id: wine._id }, stateSet({
      status: 'failed', attempts, decidedAt: new Date(),
      notes: `This wine could not be sent to the shared registry (${reason}). Try offering it again later.`,
    }));
    logAudit(null, 'bridge.contribution.failed', { type: 'wine', id: wine._id }, { attempts, reason });
    return 'stop';
  }
  await WineDefinition.updateOne({ _id: wine._id }, stateSet({ status: 'queued', sentAt: null, attempts, queuedAt: new Date() }));
  logger.warn({ wineId: String(wine._id), reason, attempts }, '[bridge] contribution not sent; back of the queue');
  return 'stop';
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
      await WineDefinition.updateOne({ _id: wine._id }, stateSet({ status: 'sent', requestId, sentAt: new Date(), notes: null, decidedAt: null, attempts: 0, misses: 0 }));
      logAudit(null, 'bridge.contribution.sent', { type: 'wine', id: wine._id },
        { registryRequestId: requestId, windows: payload.windows?.length || 0, picture: !!payload.image, reused: !!r.body?.request?.reused });
      return 'sent';
    }
    if (r && !r.ok && (r.status === 400 || (r.status === 403 && r.code === 'banned') || r.status === 413)) {
      await WineDefinition.updateOne({ _id: wine._id }, stateSet({
        status: 'failed', notes: String(r.message || 'The shared registry refused this wine as sent.').slice(0, 2000), decidedAt: new Date(),
      }));
      logAudit(null, 'bridge.contribution.failed', { type: 'wine', id: wine._id }, { status: r.status, message: r.message || null });
      return 'failed';
    }
    return giveBack(wine, r);
  } catch (err) {
    logger.warn({ err, wineId: String(wine._id) }, '[bridge] contribution send failed');
    return giveBack(wine, { ok: false, status: 0, code: 'network' })
      .catch((e) => { logger.warn({ err: e, wineId: String(wine._id) }, '[bridge] contribution not put back in the queue'); return 'stop'; });
  }
}

/**
 * Finish what cellarion.app has answered. An approved offer is linked
 * (registryBridge.linkContributedWine), or marked duplicate when this install
 * already holds the registry's copy; a duplicate whose copy is gone (merged
 * into it, or deleted) is linked now. A declined one keeps the registry's
 * reason. A sent offer with no usable answer for MISS_LIMIT checks (the
 * registry does not know it, or its wine is not visible) is failed, and so is
 * one approved as a registry wine that no longer exists. At most
 * SYNC_LINK_MAX links per run, CALL_PAUSE_MS apart; an unreachable registry
 * ends the linking for the run. Oldest-checked first. Run hourly by the
 * scheduler. Returns counts.
 */
async function syncContributions({ now = new Date(), pauseMs = CALL_PAUSE_MS } = {}) {
  if (!bridge.isEnabled()) return { skipped: 'disabled' };
  if (syncing) return { skipped: 'running' };
  syncing = true;
  try {
    await tidyStates();
    const counts = { checked: 0, linked: 0, declined: 0, duplicates: 0, failures: 0, expired: 0 };
    let links = 0;
    let linkingStopped = false;
    const link = async (wineId, registryId) => {
      if (links > 0) await pause(pauseMs);
      links++;
      const r = await bridge.linkContributedWine(wineId, registryId);
      if (!r.ok && r.code === 'unavailable') linkingStopped = true;
      return r;
    };
    const canLink = () => !linkingStopped && links < SYNC_LINK_MAX;
    const mark = (w, patch) => WineDefinition.updateOne({ _id: w._id, 'registryContribution.status': w.registryContribution.status }, stateSet(patch))
      .catch((err) => logger.warn({ err, wineId: String(w._id) }, '[bridge] contribution check not stamped'));
    const fail = async (w, notes, detail) => {
      await WineDefinition.updateOne({ _id: w._id }, stateSet({ status: 'failed', notes, decidedAt: now, checkedAt: now }));
      logAudit(null, 'bridge.contribution.failed', { type: 'wine', id: w._id }, detail);
    };

    // Duplicates whose copy here is gone: nothing stands in the way any more.
    const duplicates = await WineDefinition.find({ 'registryContribution.status': 'duplicate', 'registryContribution.approvedRegistryId': { $type: 'string' } })
      .select('_id registryContribution').limit(SYNC_BATCH_MAX).lean();
    if (duplicates.length) {
      const copies = await localCopies(duplicates.map((d) => d.registryContribution.approvedRegistryId));
      for (const d of duplicates) {
        const registryId = d.registryContribution.approvedRegistryId;
        if (copies.has(registryId) || !canLink()) continue;
        const r = await link(d._id, registryId);
        if (r.ok) {
          counts.linked++;
          logAudit(null, 'bridge.contribution.linked', { type: 'wine', id: d._id }, { registryId, afterDuplicate: true });
        }
      }
    }

    const waiting = await WineDefinition.find({ 'registryContribution.status': 'sent', 'registryContribution.requestId': { $type: 'string' } })
      .select('_id registryContribution')
      .sort({ 'registryContribution.checkedAt': 1, 'registryContribution.sentAt': 1 })
      .limit(SYNC_BATCH_MAX).lean();
    counts.checked = waiting.length;
    if (!waiting.length) return counts;
    const answers = await client.requestStatuses(waiting.map((w) => w.registryContribution.requestId));
    if (answers === null) return { ...counts, checked: 0, failed: true };
    const byId = new Map(answers.map((a) => [String(a.id), a]));

    for (const w of waiting) {
      const requestId = w.registryContribution.requestId;
      const a = byId.get(requestId);
      try {
        if (a && a.status === 'resolved' && a.wine && isValidId(a.wine.id)) {
          if (!canLink()) { await mark(w, { checkedAt: now }); continue; }
          const linked = await link(w._id, a.wine.id);
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
          if (linked.code === 'not_found') {
            counts.failures++;
            await fail(w, 'Approved on cellarion.app, but the registry wine it became is no longer there. Offer it again.', { registryRequestId: requestId, registryId: String(a.wine.id), reason: 'not_found' });
            continue;
          }
          counts.failures++;
          await mark(w, { checkedAt: now });
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
        if (a && a.status === 'pending') { await mark(w, { checkedAt: now, misses: 0 }); continue; }
        // No usable answer: the registry does not know this request for this
        // account (a key from another account, say), or the wine it was
        // approved as is not visible to a bridge.
        const misses = (w.registryContribution.misses || 0) + 1;
        if (misses >= MISS_LIMIT) {
          counts.expired++;
          await fail(w, a
            ? 'Approved on cellarion.app, but the registry wine it became is not available to this install. Offer it again later.'
            : 'The shared registry no longer knows this offer (was the bridge key replaced?). Offer it again.',
          { registryRequestId: requestId, reason: a ? 'not_visible' : 'unknown', misses });
          continue;
        }
        await mark(w, { checkedAt: now, misses });
      } catch (err) {
        counts.failures++;
        logger.warn({ err, wineId: String(w._id) }, '[bridge] contribution sync failed for one wine');
        await mark(w, { checkedAt: now });
      }
    }
    if (counts.linked || counts.declined || counts.duplicates || counts.failures || counts.expired) {
      logger.info(counts, '[bridge] contribution sync');
    }
    return counts;
  } finally {
    syncing = false;
  }
}

/**
 * Take back an offer that is not waiting on cellarion.app (queued, declined,
 * duplicate or failed). It becomes 'withdrawn': left out of "offer every
 * wine", offerable again by hand. One already sent is the registry's to
 * answer. Returns { ok: true } | { ok: false, code: 'invalid' | 'not_found' | 'sent' }.
 */
async function withdrawContribution({ wineId, req, via = 'web' } = {}) {
  if (!isValidId(wineId)) return { ok: false, code: 'invalid' };
  const res = await WineDefinition.updateOne(
    { _id: { $eq: String(wineId) }, 'registryContribution.status': { $in: WITHDRAWABLE } },
    stateSet({ status: 'withdrawn', decidedAt: new Date(), attempts: 0, misses: 0 })
  );
  if (!res.modifiedCount) {
    const wine = await WineDefinition.findOne({ _id: { $eq: String(wineId) } }).select('registryContribution').lean();
    const status = wine?.registryContribution?.status;
    return { ok: false, code: status === 'sent' || status === 'sending' ? 'sent' : 'not_found' };
  }
  logAudit(req, 'bridge.contribution.withdraw', { type: 'wine', id: wineId }, { via });
  return { ok: true };
}

/**
 * The state shown to a person: no request ids, nothing internal. A withdrawn
 * offer reads as none (the wine may be offered again). duplicateOf is the
 * wine HERE that holds the registry wine a duplicate was approved as, looked
 * up now (copies: registry id → local id), so it follows merges.
 */
function stateOut(c, copies = new Map()) {
  if (!c || c.status === 'withdrawn') return null;
  return {
    status: c.status,
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
 * (declined, duplicate, failed), most recent first. Withdrawn offers are
 * neither: an admin set them aside.
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

function _reset() { sending = false; syncing = false; }

module.exports = {
  queueContributions, sendQueued, syncContributions, withdrawContribution, contributionForWine, contributionOverview,
  contributionPayload, reviewedWindows, OFFERABLE, QUOTA_RESERVE, QUEUE_MAX, ATTEMPT_LIMIT, MISS_LIMIT, SYNC_LINK_MAX, _reset,
};
