const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const User = require('../models/User');
const searchService = require('../services/search');
const { findVisibleWine } = require('../services/wineVisibility');
const { absoluteImageUrl } = require('../services/photoState');
const { recordRead } = require('../services/registryReadTracker');
const { dataForWine, suggestValue } = require('../services/registryDataOps');
const { createFieldCorrection } = require('../services/wineProposalOps');
const { createWineRequest } = require('../services/accountOps');
const { createNotifications } = require('../services/notifications');
const { logAudit } = require('../services/audit');
const { rateLimitKey } = require('../utils/clientIp');
const BridgeKey = require('../models/BridgeKey');
const { requireBridgeKey } = require('../middleware/bridgeKeyAuth');
const { quota, usageFor, capsNow } = require('../services/bridgeQuota');
const rateLimitsConfig = require('../config/rateLimits');
const { CURRENT_REGISTRY_TERMS_VERSION } = require('../config/legal');

// Registry Bridge, protocol v1 (REGISTRY_LOCKDOWN_PLAN §6). What a self-hosted
// Cellarion may do with the shared registry, one wine at a time:
//   GET  /search?q=          up to 10 identities (no profiles)
//   GET  /wines/:id          one wine in full: identity, profile, windows, values
//   POST /wines/changes      which of the ids the install HOLDS changed since a time
//   POST /requests           a wine request into the hosted intake
//   POST /corrections        a field-correction proposal into the admin queue
//   POST /values             a public-value suggestion into the review queue
//   GET  /me                 the key, its quotas and today's spend
// No bulk listing, no snapshot, no global change feed, no embeddings — the
// registry never leaves cellarion.app as a whole. Bridge keys are counted by
// the same distinct-wines counter as every other reader (kind 'key') and a
// canary wine fetched through a key names the key in the readers report.

const SEARCH_LIMIT = 10;                 // == USER_SEARCH_LIMIT in routes/wines.js
const CANARY_ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;
const QUERY_MIN = 2;
const QUERY_MAX = 120;
const CHANGES_MAX_IDS = 5000;
const VISIBLE = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
// Search never returns a canary (a customer must not be able to find a wine
// that does not exist); a direct fetch still serves one — that is the path a
// copier walks, and the fetch is what gets reported.
const SEARCH_VISIBLE = { ...VISIBLE, canary: { $ne: true } };
const IDENTITY_SELECT = 'name producer slug country region appellation classification grapes type image imageCredit';
// The profile fields that are registry content. Never the hold/suspect
// bookkeeping, the model name, the input snapshot or the producer note.
const PROFILE_FIELDS = ['body', 'tannin', 'acidity', 'sweetness', 'flavors', 'foodPairings', 'description', 'source', 'generatedAt', 'verifiedAt'];

// Strict: mongoose.isValidObjectId() also accepts any 12-character string, so
// a nested value could reach $in and raise a CastError 500 (audit 2026-09-08).
const isValidId = (id) => /^[a-f0-9]{24}$/i.test(String(id));

// Pre-auth per-address limiter: bounds key guessing and probing. A
// self-hosted install is one address for all its users, so this is loose;
// the real budget is the per-key limiter after auth.
const ipLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'bridge_ip', limit: 600 });
    res.status(429).json({ error: 'Too many bridge requests from this network — try again in a few minutes.', code: 'rate_limited' });
  },
});
// Per-key burst limiter (plan §6: 60 per minute by default). Tunable at
// runtime together with the daily quotas (config/rateLimits.js `bridge`
// group); read per request so a change needs no restart.
const BURST_PER_MINUTE = 60;
function burstPerMinute() {
  const v = rateLimitsConfig.get().bridge?.burstPerMinute;
  return Number.isInteger(v) && v > 0 ? v : BURST_PER_MINUTE;
}
const keyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: () => burstPerMinute(),
  keyGenerator: (req) => (req.bridge?.key?.id ? `k:${req.bridge.key.id}` : rateLimitKey(req)),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    const limit = burstPerMinute();
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'bridge_key', limit, key: req.bridge?.key?.id });
    res.status(429).json({ error: `This bridge key made more than ${limit} requests in a minute — slow down.`, code: 'burst' });
  },
});

// Kill switch: `bridge.enabled = 0` closes the whole protocol with a clear
// 503, the lever routes/mcp.js has had since it shipped and this surface
// lacked (audit 2026-09-08). Read from the in-memory config, so it takes
// effect on the next request without a restart.
function bridgeOpen(req, res, next) {
  if ((rateLimitsConfig.get().bridge || {}).enabled === 0) {
    return res.status(503).json({ error: 'The Registry Bridge is closed on this instance right now.', code: 'closed' });
  }
  next();
}

router.use(bridgeOpen, ipLimiter, requireBridgeKey, keyLimiter);

function nameOf(ref) {
  if (!ref) return null;
  if (typeof ref === 'object' && ref.name) return ref.name;
  return null;
}

function identity(w) {
  return {
    id: String(w._id),
    slug: w.slug || null,
    producer: w.producer || null,
    name: w.name,
    type: w.type || null,
    appellation: w.appellation || null,
    classification: w.classification || null,
    region: nameOf(w.region),
    country: nameOf(w.country),
    grapes: Array.isArray(w.grapes) ? w.grapes.map((g) => (g && g.name) || null).filter(Boolean) : [],
    // A URL, never bytes: the picture stays under the hosted site's rules.
    image: w.image ? absoluteImageUrl(w.image) : null,
    imageCredit: w.imageCredit || null,
  };
}

function profileOf(ap) {
  if (!ap || typeof ap !== 'object') return null;
  const hasText = typeof ap.description === 'string' && ap.description.trim();
  const hasStructure = ap.body || ap.tannin || ap.acidity || ap.sweetness;
  if (!hasText && !hasStructure) return null;
  const out = {};
  for (const f of PROFILE_FIELDS) if (ap[f] !== undefined) out[f] = ap[f];
  out.source = ap.source === 'curator' ? 'curator' : 'ai';
  return out;
}

function windowOf(p) {
  const phase = (from, until) => ({ from: from ?? null, until: until ?? null });
  return {
    vintage: p.vintage,
    // NV rows hold year-OFFSETS from purchase, not calendar years.
    relative: !!p.relative,
    early: phase(p.earlyFrom, p.earlyUntil),
    peak: phase(p.peakFrom, p.peakUntil),
    late: phase(p.lateFrom, p.lateUntil),
  };
}

const CODE_STATUS = { invalid: 400, banned: 403, limit: 429, not_found: 404, conflict: 409 };
function sendResult(res, r, ok) {
  if (r && r.ok === false) {
    return res.status(CODE_STATUS[r.code] || 400).json({ error: r.message, code: r.code });
  }
  return ok(r);
}

/**
 * A canary fetched through a key: audit + tell the admins now, not tomorrow.
 *
 * The AUDIT row is written for every hit; the notification is throttled to one
 * per key per day. Canary ids are discoverable from public pages, so an
 * unthrottled notify was a way to bury admins in their own alarm (audit
 * 2026-09-08).
 */
async function reportCanaryFetch(req, wine) {
  try {
    logAudit(req, 'bridge.canary_hit', { type: 'wine', id: wine._id }, { key: req.bridge.key.id, keyName: req.bridge.key.name, instanceHost: req.bridge.key.instanceHost });
    const alerted = await BridgeKey.findOneAndUpdate(
      { _id: req.bridge.keyDoc._id, $or: [{ canaryAlertAt: null }, { canaryAlertAt: { $lt: new Date(Date.now() - CANARY_ALERT_THROTTLE_MS) } }] },
      { $set: { canaryAlertAt: new Date() } },
      { new: false }
    ).select('_id').lean();
    if (!alerted) return;   // already told today; the audit row still records the hit
    const admins = await User.find({ roles: 'admin' }).select('_id').lean();
    await createNotifications(admins.map((a) => ({
      userId: a._id,
      type: 'registry_read_alert',
      title: 'Registry bridge key fetched a canary wine',
      message: `Key "${req.bridge.key.name}" (${req.bridge.key.prefix}…, ${req.bridge.key.instanceHost || 'unknown host'}) fetched a canary wine by id. That path is walked by copiers, not by add-bottle. Review the key in Admin.`,
      link: null,
    })));
  } catch (err) {
    console.error('[bridge] canary report failed:', err.message);
  }
}

// GET /v1/me
router.get('/me', async (req, res) => {
  try {
    const usage = await usageFor(req.bridge.keyDoc);
    res.json({
      key: { id: req.bridge.key.id, name: req.bridge.key.name, prefix: req.bridge.key.prefix, instanceHost: req.bridge.key.instanceHost, createdAt: req.bridge.keyDoc.createdAt },
      terms: { version: req.bridge.keyDoc.termsVersion, current: CURRENT_REGISTRY_TERMS_VERSION },
      quotas: capsNow(),
      burstPerMinute: burstPerMinute(),
      usage,
      protocol: 'v1',
    });
  } catch (error) {
    console.error('Bridge /me error:', error);
    res.status(500).json({ error: 'Failed to read the key' });
  }
});

// GET /v1/search?q=  — identities only, capped like the web UI's add-bottle search.
// Validation runs BEFORE the quota is spent: a malformed call used to cost a
// unit, and with one change check a day that meant a single typo silenced the
// weekly refresh until UTC midnight (audit 2026-09-08).
function validSearch(req, res, next) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < QUERY_MIN || q.length > QUERY_MAX) {
    return res.status(400).json({ error: `q must be ${QUERY_MIN}–${QUERY_MAX} characters`, code: 'invalid' });
  }
  req.bridgeQuery = q;
  next();
}

function validChanges(req, res, next) {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0 || ids.length > CHANGES_MAX_IDS || !ids.every(isValidId)) {
    return res.status(400).json({ error: `ids must be 1–${CHANGES_MAX_IDS} wine ids`, code: 'invalid' });
  }
  const since = req.body?.since ? new Date(req.body.since) : new Date(0);
  if (Number.isNaN(since.getTime())) return res.status(400).json({ error: 'since must be an ISO date', code: 'invalid' });
  req.bridgeIds = ids;
  req.bridgeSince = since;
  next();
}

router.get('/search', validSearch, quota('searches'), async (req, res) => {
  const q = req.bridgeQuery;
  try {
    let wines = null;
    if (searchService.getIsAvailable()) {
      try {
        const { ids } = await searchService.search(q, { limit: SEARCH_LIMIT });
        const found = await WineDefinition.find({ _id: { $in: ids }, ...SEARCH_VISIBLE })
          .select(IDENTITY_SELECT).populate(['country', 'region', 'grapes']).lean();
        const order = new Map(ids.map((id, i) => [String(id), i]));
        found.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
        wines = found;
      } catch (err) {
        console.warn('[bridge] Meilisearch query failed, falling back to MongoDB:', err.message);
      }
    }
    if (!wines) {
      wines = await WineDefinition.find({ ...SEARCH_VISIBLE, $text: { $search: q } })
        .select({ ...Object.fromEntries(IDENTITY_SELECT.split(' ').map((f) => [f, 1])), score: { $meta: 'textScore' } })
        .sort({ score: { $meta: 'textScore' } })
        .limit(SEARCH_LIMIT)
        .populate(['country', 'region', 'grapes'])
        .lean();
    }
    // A search is a read of the registry too — ten identities a call, hundreds
    // of calls a day. Counting only single fetches left the copy detector
    // blind to this path (audit 2026-09-08). Detection counts on the owner.
    if (wines.length) {
      recordRead({ key: `user:${req.user.id}`, kind: 'user' }, wines.map((w) => w._id)).catch(() => {});
    }
    res.json({ query: q, count: wines.length, wines: wines.map(identity) });
  } catch (error) {
    console.error('Bridge search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /v1/wines/:id — one wine in full. Counted as a distinct-wine read under
// the key, so keys sit in the same readers report as every other reader.
router.get('/wines/:id', quota('fetches'), async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid wine id', code: 'invalid' });
  try {
    const wine = await findVisibleWine(req.params.id, {
      userId: null, roles: [], lean: true,
      select: `${IDENTITY_SELECT} aiProfile canary lwin communityRating updatedAt`,
      populate: ['country', 'region', 'grapes'],
    });
    if (!wine || wine.nonWine) return res.status(404).json({ error: 'Wine not found', code: 'not_found' });

    // Detection counts on the OWNER: keys are re-mintable, so a per-key row
    // let one account stay under the alert level by cycling keys (audit
    // 2026-09-08). The per-key row stays for attribution on the admin page.
    await recordRead({ key: `user:${req.user.id}`, kind: 'user' }, wine._id);
    recordRead({ key: `key:${req.bridge.key.id}`, kind: 'key' }, wine._id).catch(() => {});
    if (wine.canary) await reportCanaryFetch(req, wine);

    const [windows, values] = await Promise.all([
      WineVintageProfile.find({ wineDefinition: wine._id, status: 'reviewed' })
        .select('vintage relative earlyFrom earlyUntil peakFrom peakUntil lateFrom lateUntil').lean(),
      dataForWine(String(wine._id), null, { roles: [] }).catch(() => ({ ok: false })),
    ]);

    res.json({
      wine: {
        ...identity(wine),
        lwin: wine.lwin || null,
        communityRating: wine.communityRating ?? null,
        updatedAt: wine.updatedAt || null,
        profile: profileOf(wine.aiProfile),
        windows: windows.map(windowOf),
        // Published registry values only; who contributed them stays on the
        // hosted page.
        // A field whose figures exist only per vintage has a null wine-wide
        // value; dropping it took its overrides with it (audit 2026-09-08).
        values: values && values.ok
          ? values.fields.filter((f) => f.value !== null && f.value !== undefined || f.wineValue !== null && f.wineValue !== undefined || (f.overrides || []).length > 0)
            .map((f) => ({ key: f.key, value: f.value, wineValue: f.wineValue ?? null, overrides: f.overrides || [] }))
          : [],
      },
    });
  } catch (error) {
    console.error('Bridge wine fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch the wine' });
  }
});

// POST /v1/wines/changes — { ids: [...], since: ISO } → which of THOSE changed.
// Never a global feed: an install can only ask about wines it already holds.
router.post('/wines/changes', validChanges, quota('changeChecks'), async (req, res) => {
  const ids = req.bridgeIds;
  const since = req.bridgeSince;
  try {
    const checkedAt = new Date();
    // The same visibility the single-wine fetch applies: a hidden row must
    // report as removed, not as changed, or the change check is an existence
    // oracle for wines /wines/:id would 404 (audit 2026-09-08).
    const found = await WineDefinition.find({ _id: { $in: ids }, ...VISIBLE, canary: { $ne: true } })
      .select('_id updatedAt nonWine').lean();
    const present = new Map(found.map((w) => [String(w._id), w]));
    const changed = [];
    const removed = [];
    for (const id of ids) {
      const w = present.get(String(id));
      if (!w || w.nonWine) { removed.push(String(id)); continue; }
      if (w.updatedAt && new Date(w.updatedAt).getTime() > since.getTime()) changed.push({ id: String(id), updatedAt: w.updatedAt });
    }
    res.json({ since, checkedAt, checked: ids.length, changed, removed });
  } catch (error) {
    console.error('Bridge changes error:', error);
    res.status(500).json({ error: 'Change check failed' });
  }
});

// POST /v1/requests — { wineName, sourceUrl, image? } → the hosted wine-request queue.
router.post('/requests', quota('contributions'), async (req, res) => {
  try {
    const r = await createWineRequest(req.user.id, {
      wineName: req.body?.wineName, sourceUrl: req.body?.sourceUrl, image: req.body?.image,
    }, { via: 'bridge', req });
    if (r.error) return res.status(r.error.status || 400).json({ error: r.error.message, code: 'invalid' });
    logAudit(req, 'bridge.request.forwarded', { type: 'wineRequest', id: r.wineRequest._id },
      { key: req.bridge.key.id, instanceHost: req.bridge.key.instanceHost });
    res.status(201).json({ request: { id: r.wineRequest._id, status: r.wineRequest.status, wineName: r.wineRequest.wineName } });
  } catch (error) {
    console.error('Bridge request error:', error);
    res.status(500).json({ error: 'Failed to file the request' });
  }
});

// POST /v1/corrections — { wineId, fields, reason, evidenceUrl } → admin-reviewed proposal.
router.post('/corrections', quota('contributions'), async (req, res) => {
  try {
    const r = await createFieldCorrection(req.user.id, {
      wineId: req.body?.wineId, fields: req.body?.fields, reason: req.body?.reason, evidenceUrl: req.body?.evidenceUrl,
    }, { via: 'bridge', req });
    return sendResult(res, r, (out) => {
      logAudit(req, 'bridge.correction.forwarded', { type: 'wineCorrectionProposal', id: out.proposal?._id },
        { key: req.bridge.key.id, instanceHost: req.bridge.key.instanceHost, wine: req.body?.wineId });
      res.status(201).json({ proposal: { id: out.proposal?._id, status: out.proposal?.status || 'pending', applied: !!out.applied } });
    });
  } catch (error) {
    console.error('Bridge correction error:', error);
    res.status(500).json({ error: 'Failed to file the correction' });
  }
});

// POST /v1/values — { wineId, keyName | keyId, value, reason, evidenceUrl, vintage } → value review queue.
router.post('/values', quota('contributions'), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await suggestValue(req.user.id, {
      wineId: b.wineId, keyId: b.keyId, keyName: b.keyName, value: b.value, reason: b.reason, evidenceUrl: b.evidenceUrl, vintage: b.vintage,
    }, { via: 'bridge', req });
    return sendResult(res, r, (out) => {
      logAudit(req, 'bridge.value.forwarded', { type: 'registryDataValue', id: out.value?._id || out.id },
        { key: req.bridge.key.id, instanceHost: req.bridge.key.instanceHost, wine: b.wineId });
      res.status(201).json({ suggestion: { id: out.value?._id || out.id || null, status: out.status || out.value?.status || 'suggested' } });
    });
  } catch (error) {
    console.error('Bridge value error:', error);
    res.status(500).json({ error: 'Failed to file the value' });
  }
});

module.exports = router;
module.exports.SEARCH_VISIBLE = SEARCH_VISIBLE;
module.exports.BURST_PER_MINUTE = BURST_PER_MINUTE;
