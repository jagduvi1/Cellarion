// Sommelier price curation, the one body behind both doors: the REST routes in
// routes/somm/prices.js (the web somm page) and the MCP tools in
// mcp/tools/somm/prices.js (list_price_tracking_requests, set_vintage_price,
// reject_price_request), plus the undo inverses mcp/revert.js applies.
//
// What is shared here is the part that must not drift between the doors: which
// requested pairs are actionable (a curator decline hides the pair; a price
// older than PRICE_STALE_MS makes it actionable again), how a snapshot is
// recorded and its requesters told, how a decline suppresses a pair and what
// an undo needs to lift exactly that suppression. Each door keeps its own
// input parsing and its own wording for refusals, and passes `via` so the
// audit row says which door was used.
//
// This module stays free of Express and of the MCP envelope.

const WineVintagePrice = require('../models/WineVintagePrice');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const WineDefinition = require('../models/WineDefinition');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { createNotification } = require('./notifications');
const { logAudit, logger } = require('./audit');
const { stripHtml } = require('../utils/sanitize');
const { parseAndValidateVintage } = require('../utils/validation');
const { SUPPORTED_CURRENCIES } = require('../config/currencies');

/** A price older than this makes its pair actionable again in the queue. */
const PRICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

/** Decline reasons are written for the requester: required, plain text, bounded (the max matches PriceTrackingSkip.reason). */
const DECLINE_REASON_MIN = 5;
const DECLINE_REASON_MAX = 500;

const pairKey = (wineId, vintage) => `${wineId}:${vintage}`;

/** "Producer — Name" for notifications, or the fallback when the wine is gone. */
const wineLabel = (wine, fallback) => (wine ? [wine.producer, wine.name].filter(Boolean).join(' — ') : fallback);

/**
 * Requests whose wine still exists and whose pair no curator has declined.
 * The decline flow deletes the request AND records a PriceTrackingSkip, so
 * the skip lookup is normally a no-op; it exists so a re-request that raced
 * a decline cannot resurrect the pair while the skip stands. No query at all
 * when nothing is alive.
 */
async function dropSkippedPairs(requests) {
  const alive = (requests || []).filter((r) => r.wineDefinition);
  if (alive.length === 0) return [];
  const skips = await PriceTrackingSkip.find({ wineDefinition: { $in: alive.map((r) => r.wineDefinition._id) } })
    .select('wineDefinition vintage')
    .lean();
  if (!skips.length) return alive;
  const skipped = new Set(skips.map((s) => pairKey(s.wineDefinition, s.vintage)));
  return alive.filter((r) => !skipped.has(pairKey(r.wineDefinition._id, r.vintage)));
}

/**
 * The newest snapshot per (wine, vintage) among the given wines, as a Map of
 * pairKey → { price, currency, setAt, source }. $last is only meaningful with
 * a defined input order, hence the $sort; the $match keeps the $group from
 * scanning every price ever recorded.
 */
async function latestPriceByPair(wineIds) {
  const rows = await WineVintagePrice.aggregate([
    { $match: { wineDefinition: { $in: wineIds } } },
    { $sort: { setAt: 1 } },
    { $group: {
      _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' },
      setAt: { $last: '$setAt' },
      price: { $last: '$price' },
      currency: { $last: '$currency' },
      source: { $last: '$source' },
    } },
  ]);
  return new Map(rows.map((r) => [
    pairKey(r._id.wineDefinition, r._id.vintage),
    { price: r.price, currency: r.currency, setAt: r.setAt, source: r.source },
  ]));
}

/** No snapshot at all, or one older than PRICE_STALE_MS. */
function isStalePrice(latest, now = Date.now()) {
  if (!latest) return true;
  return new Date(latest.setAt).getTime() < now - PRICE_STALE_MS;
}

/** Most requesters first, then the oldest first request. Sorts in place and returns the rows. */
function sortPriceQueue(rows) {
  return rows.sort((a, b) =>
    (b.request.requesters?.length || 0) - (a.request.requesters?.length || 0)
    || new Date(a.request.firstRequestedAt || 0) - new Date(b.request.firstRequestedAt || 0));
}

/**
 * The price queue: from the loaded tracking requests (each with its
 * wineDefinition populated), the pairs a curator can act on — not declined,
 * and with no price or a stale one — sorted for the queue. Returns
 * [{ request, latest }], latest being { price, currency, setAt, source } or
 * null. Callers: GET /api/somm/prices/queue and list_price_tracking_requests.
 */
async function actionablePriceRequests(requests, { now = Date.now() } = {}) {
  const alive = await dropSkippedPairs(requests);
  if (alive.length === 0) return [];
  const latestByPair = await latestPriceByPair(alive.map((r) => r.wineDefinition._id));
  const rows = alive
    .map((request) => ({ request, latest: latestByPair.get(pairKey(request.wineDefinition._id, request.vintage)) || null }))
    .filter(({ latest }) => isStalePrice(latest, now));
  return sortPriceQueue(rows);
}

/**
 * The bottles' canonical vintage for a price ("nv" → "NV"; a malformed or
 * impossible year refused), so the snapshot matches the bottles and the
 * request it answers. Codes: 'required' (blank — the shared parser would read
 * it as NV), 'invalid' (with the parser's error text), 'unknown' (an unknown
 * vintage has no vintage price). The caller words the refusal.
 */
function parsePriceVintage(raw) {
  if (!String(raw ?? '').trim()) return { ok: false, code: 'required' };
  const parsed = parseAndValidateVintage(raw);
  if (!parsed.ok) return { ok: false, code: 'invalid', error: parsed.error };
  if (parsed.value === 'Unknown') return { ok: false, code: 'unknown' };
  return { ok: true, value: parsed.value };
}

/** Upper-cased, USD by default; ok only for a supported currency. */
function normalizeCurrency(raw) {
  const value = String(raw || 'USD').toUpperCase();
  return { ok: SUPPORTED_CURRENCIES.includes(value), value };
}

const trimmedOrUndefined = (value) => (value ? String(value).trim() || undefined : undefined);

/**
 * Tell everyone who asked for this pair that a price exists now. Best-effort
 * and not awaited by the callers: delivery never blocks the response. The
 * link is the public wine page — requesters are members, and the somm prices
 * page answers them with Access Denied. The label comes from the request's
 * wine when it is populated, else from the wine the caller already loaded.
 */
function notifyPriceRequesters({ wineId, vintage, entry, wine }) {
  return PriceTrackingRequest.findOne({ wineDefinition: wineId, vintage })
    .populate('wineDefinition', 'name producer')
    .lean()
    .then((request) => {
      if (!request?.requesters?.length) return;
      const label = wineLabel(request.wineDefinition || wine, 'wine');
      const body = `A sommelier just added a market price for ${label} ${vintage}: ${entry.currency} ${entry.price}.`;
      for (const r of request.requesters) {
        createNotification(r.user, 'price_tracked', 'Market price updated', body, `/wines/${wineId}`);
      }
    })
    .catch((err) => logger.warn({ err: err.message, wineId: String(wineId), vintage }, 'Notify price requesters failed'));
}

/**
 * Record a price snapshot (history accumulates; nothing is overwritten),
 * audit it and notify the requesters. The caller has validated the input
 * (parsePriceVintage, normalizeCurrency) and checked the wine exists and is
 * not a private draft. Today's exchange-rate snapshot is taken first so the
 * entry's setAt date anchors later conversions; it is an aid, never a reason
 * to refuse the price. Returns the saved entry.
 */
async function addPriceSnapshot({ wineId, vintage, price, currency, source, sommNotes, actorId, wine = null, req, via }) {
  try { await getOrCreateDailySnapshot(); } catch { /* conversions fall back to the nearest snapshot */ }

  const entry = new WineVintagePrice({
    wineDefinition: wineId,
    vintage,
    price,
    currency,
    source: trimmedOrUndefined(source),
    sommNotes: trimmedOrUndefined(sommNotes),
    setBy: actorId,
  });
  await entry.save();

  logAudit(req, 'somm.price.add',
    { type: 'wine', id: wineId },
    { vintage: entry.vintage, price: entry.price, currency: entry.currency, ...(via ? { via } : {}) });

  notifyPriceRequesters({ wineId, vintage: entry.vintage, entry, wine });
  return entry;
}

/**
 * The decline reason as the requester will read it: HTML stripped BEFORE the
 * length check, so markup cannot pad a reason past the minimum. Codes 'short'
 * and 'long'; the caller words the refusal.
 */
function validateDeclineReason(raw) {
  const reason = stripHtml(typeof raw === 'string' ? raw : '');
  if (!reason || reason.length < DECLINE_REASON_MIN) return { ok: false, code: 'short', reason };
  if (reason.length > DECLINE_REASON_MAX) return { ok: false, code: 'long', reason };
  return { ok: true, reason };
}

/**
 * Decline a loaded tracking request with a validated reason: record the
 * PriceTrackingSkip for the pair (the suppression that keeps it out of the
 * queue and makes routes/bottles.js refuse new requests for it), delete the
 * request, notify every requester with the reason verbatim, audit.
 *
 * $setOnInsert keeps the FIRST decline's reason if two curators race on the
 * unique (wineDefinition, vintage) index; `prev.skipCreated` records whether
 * THIS call created the suppression, because only then may an undo lift it.
 * `prev` is everything restoreDeclinedRequest needs to put the request back.
 *
 * Returns { prev, wine, requestersNotified }, or { gone: true } when the
 * request was no longer there to take (another curator declined it first):
 * nobody is notified and nothing is audited then, and the caller answers
 * "not found". Callers: POST /api/somm/prices/requests/:id/decline and
 * reject_price_request.
 */
async function declinePriceRequest({ request, reason, actorId, req, via }) {
  // No populate on the request: a deleted wine would null the ref and lose
  // the id the skip needs. The label is loaded separately, best-effort.
  const wine = await WineDefinition.findById(request.wineDefinition).select('name producer').lean();

  const skipRes = await PriceTrackingSkip.findOneAndUpdate(
    { wineDefinition: request.wineDefinition, vintage: request.vintage },
    { $setOnInsert: {
      wineDefinition: request.wineDefinition,
      vintage: request.vintage,
      reason,
      skippedBy: actorId,
      skippedAt: new Date(),
    } },
    { upsert: true, new: false, includeResultMetadata: true }
  );
  const skipCreated = !skipRes?.lastErrorObject?.updatedExisting;

  // The delete is the claim: of two curators declining the same request, one
  // takes the row, and the other must not tell the requesters a second time
  // or ledger a row it did not remove. The suppression recorded above stays
  // either way — the other curator's decline relies on it. The deleted
  // document is also the freshest list of requesters.
  const taken = await PriceTrackingRequest.findOneAndDelete({ _id: request._id });
  if (!taken) return { gone: true };

  const prev = {
    wineDefinition: String(request.wineDefinition),
    vintage: request.vintage,
    requesters: (taken.requesters || []).map((r) => ({ user: String(r.user), requestedAt: r.requestedAt, note: r.note })),
    firstRequestedAt: taken.firstRequestedAt || null,
    lastRequestedAt: taken.lastRequestedAt || null,
    skipCreated,
  };

  const label = wineLabel(wine, 'this wine');
  const title = 'Price tracking request declined';
  const body = `Your request to track market price for ${label} ${request.vintage} was declined by a sommelier. Reason: ${reason}`;
  // Best-effort, like the "price added" notifications: delivery never blocks the decline.
  Promise.allSettled(prev.requesters.map((r) => createNotification(r.user, 'price_tracking_declined', title, body, null)))
    .then((results) => {
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed) logger.warn({ failed, wineId: prev.wineDefinition, vintage: prev.vintage }, 'Notify declined price requesters failed');
    });

  logAudit(req, 'somm.price.decline',
    { type: 'wine', id: request.wineDefinition },
    { vintage: request.vintage, reason, requesters: prev.requesters.length, ...(via ? { via } : {}) });

  return { prev, wine, requestersNotified: prev.requesters.length };
}

/** Undo of addPriceSnapshot: only the caller's own snapshot. Returns the deleteOne result. */
function removePriceSnapshot({ entryId, actorId }) {
  return WineVintagePrice.deleteOne({ _id: entryId, setBy: actorId });
}

/**
 * Undo of declinePriceRequest. Upsert, not insert: if a request for the pair
 * exists again by the time of the undo, the declined requesters who are not
 * on it are added to it, so the undo always lands on "everyone who asked is
 * on the request". The suppression is lifted only when this decline created
 * it, and only the caller's own skip: a skip that pre-existed is someone
 * else's judgement. Returns { requestersRestored }: how many of the declined
 * requesters this call put back. Caller: the somm_price_decline undo in
 * mcp/revert.js.
 */
async function restoreDeclinedRequest(prev, actorId) {
  const declined = prev.requesters || [];
  const res = await PriceTrackingRequest.findOneAndUpdate(
    { wineDefinition: prev.wineDefinition, vintage: prev.vintage },
    { $setOnInsert: {
      wineDefinition: prev.wineDefinition,
      vintage: prev.vintage,
      requesters: declined,
      firstRequestedAt: prev.firstRequestedAt || new Date(),
      lastRequestedAt: prev.lastRequestedAt || new Date(),
    } },
    { upsert: true, new: false, includeResultMetadata: true }
  );
  let requestersRestored = declined.length;
  const existing = res?.lastErrorObject?.updatedExisting ? res.value : null;
  if (existing) {
    const onIt = new Set((existing.requesters || []).map((r) => String(r.user)));
    const missing = declined.filter((r) => !onIt.has(String(r.user)));
    requestersRestored = missing.length;
    if (missing.length) {
      await PriceTrackingRequest.updateOne(
        { _id: existing._id },
        {
          $push: { requesters: { $each: missing } },
          ...(prev.firstRequestedAt ? { $min: { firstRequestedAt: prev.firstRequestedAt } } : {}),
        }
      );
    }
  }
  if (prev.skipCreated) {
    await PriceTrackingSkip.deleteOne({ wineDefinition: prev.wineDefinition, vintage: prev.vintage, skippedBy: actorId });
  }
  return { requestersRestored };
}

module.exports = {
  DECLINE_REASON_MIN,
  DECLINE_REASON_MAX,
  pairKey,
  wineLabel,
  isStalePrice,
  actionablePriceRequests,
  parsePriceVintage,
  normalizeCurrency,
  addPriceSnapshot,
  validateDeclineReason,
  declinePriceRequest,
  removePriceSnapshot,
  restoreDeclinedRequest,
};
