const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../../middleware/auth');
const BridgeKey = require('../../models/BridgeKey');
const BridgeUsageDay = require('../../models/BridgeUsageDay');
const RegistryReadDay = require('../../models/RegistryReadDay');
// The read counters' TTL bounds every distinct-wines figure below.
const READ_RETENTION_DAYS = RegistryReadDay.RETENTION_DAYS || 14;
const ApiToken = require('../../models/ApiToken');
const User = require('../../models/User');
const { KINDS, capsNow, importWindowActive } = require('../../services/bridgeQuota');
const { limits, dayKey } = require('../../services/registryReadTracker');
const { logAudit } = require('../../services/audit');

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

// The admin side of the Registry Bridge (REGISTRY_LOCKDOWN_PLAN §6; the
// follow-up to v1.207.0): every key with its owner, install and spend, the
// readers table the 05:15 report is drawn from, and revocation with a reason
// the owner is shown. docs/registry-bridge-enforcement.md walks through the
// decisions this page is meant to support.
//
// Personal data here is what an admin already sees elsewhere (username,
// email, the masked address the limiters key on). Nothing about anyone's
// cellar is read — only counters.

const REVOKED_SHOWN_DAYS = 90;  // a revoked key stays in the list this long
const KEYS_MAX = 500;
const READERS_MAX = 50;
const { REVOKE_REASON_MAX } = BridgeKey;

const isValidId = (id) => mongoose.isValidObjectId(String(id));

function daysParam(raw, dflt = 7) {
  return Math.min(Math.max(parseInt(raw, 10) || dflt, 1), 90);
}

/** First UTC day of a trailing window of `days` days, as YYYY-MM-DD. */
function sinceDay(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return dayKey(d);
}

const zeroKinds = () => Object.fromEntries(KINDS.map((k) => [k, 0]));

/** Per-key spend from the quota counters: the window's sums and today's. */
async function usageByKey(days, today) {
  const sums = {};
  for (const kind of KINDS) {
    sums[kind] = { $sum: `$${kind}` };
    sums[`today_${kind}`] = { $sum: { $cond: [{ $eq: ['$day', today] }, `$${kind}`, 0] } };
  }
  const rows = await BridgeUsageDay.aggregate([
    { $match: { day: { $gte: sinceDay(days) } } },
    { $group: { _id: '$key', ...sums, days: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

/**
 * Distinct wines per reader from the read counters — the copy detector. One
 * row per reader over the window: the worst day, the sum, today, on how many
 * days it read at all and on how many it was refused.
 */
async function readsByReader(days, today, match = {}) {
  return RegistryReadDay.aggregate([
    { $match: { day: { $gte: sinceDay(days) }, ...match } },
    { $project: { readerKey: 1, kind: 1, day: 1, count: 1, blockedAt: 1, distinct: { $size: { $ifNull: ['$wines', []] } } } },
    { $group: {
      _id: '$readerKey',
      kind: { $first: '$kind' },
      reads: { $sum: '$count' },
      distinctMax: { $max: '$distinct' },
      distinctSum: { $sum: '$distinct' },
      distinctToday: { $sum: { $cond: [{ $eq: ['$day', today] }, '$distinct', 0] } },
      days: { $sum: 1 },
      blockedDays: { $sum: { $cond: [{ $gt: ['$blockedAt', null] }, 1, 0] } },
    } },
    { $sort: { distinctMax: -1, reads: -1 } },
  ]);
}

// GET /api/admin/bridge/keys?days=7 — every active key plus those revoked in
// the last 90 days, each with its owner, install, today's and the window's
// spend, and the distinct-wines figure the readers report alerts on.
router.get('/keys', async (req, res) => {
  try {
    const days = daysParam(req.query.days);
    // The read counters live for RETENTION_DAYS; asking for 30 or 90 silently
    // returned a 14-day answer under a 90-day label (audit 2026-09-08).
    const readDays = Math.min(days, READ_RETENTION_DAYS);
    const today = dayKey();
    const revokedSince = new Date(Date.now() - REVOKED_SHOWN_DAYS * 86400e3);
    const [keys, usage, reads] = await Promise.all([
      BridgeKey.find({ $or: [{ revokedAt: null }, { revokedAt: { $gte: revokedSince } }] })
        .sort({ revokedAt: 1, createdAt: -1 })   // null (active) first, newest first within
        .limit(KEYS_MAX)
        .populate('user', 'username email')
        .populate('revokedBy', 'username')
        .lean(),
      usageByKey(days, today),
      readsByReader(readDays, today, { kind: 'key' }),
    ]);
    const readMap = new Map(reads.map((r) => [String(r._id), r]));
    const rows = keys.map((k) => {
      const id = String(k._id);
      const u = usage.get(id) || {};
      const r = readMap.get(`key:${id}`) || {};
      const todayUse = zeroKinds();
      const periodUse = zeroKinds();
      for (const kind of KINDS) {
        todayUse[kind] = u[`today_${kind}`] || 0;
        periodUse[kind] = u[kind] || 0;
      }
      return {
        id,
        name: k.name,
        prefix: k.prefix,
        instanceHost: k.instanceHost || null,
        owner: k.user ? { id: String(k.user._id), username: k.user.username || null, email: k.user.email || null } : null,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt || null,
        termsVersion: k.termsVersion,
        importWindow: { active: importWindowActive(k), until: k.importWindowUntil || null },
        revokedAt: k.revokedAt || null,
        revokedBy: k.revokedBy ? (k.revokedBy.username || 'admin') : null,
        revokedReason: k.revokedReason || null,
        today: { ...todayUse, distinct: r.distinctToday || 0 },
        period: { ...periodUse, reads: r.reads || 0, distinctMax: r.distinctMax || 0, activeDays: u.days || 0 },
      };
    });
    const active = rows.filter((k) => !k.revokedAt);
    const sum = (kind) => rows.reduce((n, k) => n + (k.period[kind] || 0), 0);
    res.json({
      days,
      readDays,
      today,
      caps: capsNow(),
      alertDistinct: limits().memberAlertDistinct,
      totals: {
        active: active.length,
        revoked: rows.length - active.length,
        usedInPeriod: rows.filter((k) => k.period.activeDays > 0).length,
        searches: sum('searches'),
        fetches: sum('fetches'),
        contributions: sum('contributions'),
      },
      keys: rows,
    });
  } catch (err) {
    console.error('Admin bridge keys error:', err);
    res.status(500).json({ error: 'Failed to load bridge keys' });
  }
});

// GET /api/admin/bridge/readers?days=7 — the top readers of the registry over
// the window, every kind: anonymous addresses, signed-in users, personal
// tokens and bridge keys. Sorted by the worst day's distinct wines — the
// figure that separates a person browsing from a copier.
router.get('/readers', async (req, res) => {
  try {
    const days = daysParam(req.query.days);
    const readDays = Math.min(days, READ_RETENTION_DAYS);
    const today = dayKey();
    const rows = (await readsByReader(readDays, today)).slice(0, READERS_MAX);
    const idsOf = (prefix) => rows
      .filter((r) => typeof r._id === 'string' && r._id.startsWith(prefix))
      .map((r) => r._id.slice(prefix.length))
      .filter(isValidId);
    const keyIds = idsOf('key:');
    const userIds = idsOf('user:');
    const tokenIds = idsOf('token:');
    const [keyDocs, userDocs, tokenDocs] = await Promise.all([
      keyIds.length ? BridgeKey.find({ _id: { $in: keyIds } }).select('name instanceHost user revokedAt').populate('user', 'username').lean() : [],
      userIds.length ? User.find({ _id: { $in: userIds } }).select('username').lean() : [],
      tokenIds.length ? ApiToken.find({ _id: { $in: tokenIds } }).select('name user').populate('user', 'username').lean() : [],
    ]);
    const byId = (docs) => new Map((docs || []).map((d) => [String(d._id), d]));
    const keyMap = byId(keyDocs);
    const userMap = byId(userDocs);
    const tokenMap = byId(tokenDocs);
    const { anonymousDailyDistinct, memberAlertDistinct } = limits();

    const readers = rows.map((r) => {
      const readerKey = String(r._id);
      const id = readerKey.slice(readerKey.indexOf(':') + 1);
      let label = null;
      let owner = null;
      let keyId = null;
      let revoked = false;
      if (r.kind === 'key') {
        const k = keyMap.get(id);
        if (k) {
          label = k.instanceHost ? `${k.name} (${k.instanceHost})` : k.name;
          owner = k.user?.username || null;
          keyId = id;
          revoked = !!k.revokedAt;
        }
      } else if (r.kind === 'user') {
        const u = userMap.get(id);
        if (u) { label = u.username; owner = u.username; }
      } else if (r.kind === 'token') {
        const tk = tokenMap.get(id);
        if (tk) { label = tk.name; owner = tk.user?.username || null; }
      }
      const alertAt = r.kind === 'ip' ? anonymousDailyDistinct : memberAlertDistinct;
      return {
        readerKey,
        kind: r.kind,
        label,
        owner,
        keyId,
        revoked,
        reads: r.reads || 0,
        distinctMax: r.distinctMax || 0,
        distinctSum: r.distinctSum || 0,
        distinctToday: r.distinctToday || 0,
        days: r.days || 0,
        blockedDays: r.blockedDays || 0,
        overAlert: (r.distinctMax || 0) > alertAt,
      };
    });
    res.json({ days, readDays, retentionDays: READ_RETENTION_DAYS, today, thresholds: { anonymousDailyDistinct, memberAlertDistinct }, readers });
  } catch (err) {
    console.error('Admin bridge readers error:', err);
    res.status(500).json({ error: 'Failed to load registry readers' });
  }
});

// POST /api/admin/bridge/keys/:id/revoke { reason } — revoke someone else's
// key. The reason is mandatory: the owner is shown it in Settings, and a
// revocation nobody can explain is the one the plan says never to make.
router.post('/keys/:id/revoke', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid key id' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3 || reason.length > REVOKE_REASON_MAX) {
    return res.status(400).json({ error: `Give the owner a reason (3–${REVOKE_REASON_MAX} characters)`, code: 'reason_required' });
  }
  try {
    const key = await BridgeKey.findOne({ _id: { $eq: String(req.params.id) } });
    if (!key) return res.status(404).json({ error: 'Bridge key not found' });
    if (key.revokedAt) return res.status(409).json({ error: 'This key is already revoked', code: 'already_revoked' });
    key.revokedAt = new Date();
    key.revokedBy = req.user.id;
    key.revokedReason = reason;
    await key.save();
    logAudit(req, 'bridge.key.revoked_by_admin', { type: 'bridgeKey', id: key._id }, { name: key.name, owner: key.user, reason });
    res.json({ message: 'Bridge key revoked', id: key._id, revokedAt: key.revokedAt });
  } catch (err) {
    console.error('Admin revoke bridge key error:', err);
    res.status(500).json({ error: 'Failed to revoke bridge key' });
  }
});

module.exports = router;
