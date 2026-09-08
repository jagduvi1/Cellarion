const BridgeKey = require('../models/BridgeKey');
const User = require('../models/User');
const { logAudit } = require('../services/audit');

// Authenticate a Registry Bridge key (`cbr_...` bearer). Mounted ONLY on the
// /api/bridge/v1 router — that mount is the whole audience of a bridge key.
// It never reaches requireAuth's dispatch (which recognises JWTs and `cel_`
// tokens), so a bridge key presented anywhere else is simply a malformed
// credential and fails there.
//
// On success: req.user = the key owner's identity in the same shape the JWT
// and token paths produce (the contribution services key their budgets and
// bans on it) and req.bridge = { key, keyDoc } for the quota middleware.

const { KEY_PREFIX } = BridgeKey;
// How often lastUsedAt is persisted (and bridge.key.used audited) per key.
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;
const INSTANCE_HEADER = 'x-cellarion-instance';
const INSTANCE_MAX = 120;

function isBridgeCredential(credential) {
  return typeof credential === 'string' && credential.startsWith(KEY_PREFIX);
}

/**
 * The self-hosted backend names itself with its public host so contributions
 * and the readers report can say which install they came from. Sanitised to a
 * host-like string: anything else is dropped, never stored.
 */
function instanceHostFrom(req) {
  const raw = req.get ? req.get(INSTANCE_HEADER) : req.headers?.[INSTANCE_HEADER];
  if (!raw || typeof raw !== 'string') return null;
  // String operations, not regexes, on the untrusted part: a header of many
  // slashes must cost nothing to reject (CodeQL: polynomial regex on user data).
  let s = raw.slice(0, 4 * INSTANCE_MAX).trim().toLowerCase();
  if (s.startsWith('https://')) s = s.slice(8);
  else if (s.startsWith('http://')) s = s.slice(7);
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  let cleaned = '';
  for (const ch of s) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === ':' || ch === '_' || ch === '-') cleaned += ch;
    if (cleaned.length >= INSTANCE_MAX) break;
  }
  return cleaned || null;
}

async function requireBridgeKey(req, res, next) {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!isBridgeCredential(raw)) {
    res.set('WWW-Authenticate', 'Bearer realm="cellarion-bridge"');
    return res.status(401).json({ error: 'A Registry Bridge key is required', code: 'no_key' });
  }
  try {
    const key = await BridgeKey.findOne({ keyHash: BridgeKey.hashKey(raw), revokedAt: null });
    if (!key) {
      return res.status(401).json({ error: 'Invalid or revoked bridge key', code: 'invalid_key' });
    }
    const user = await User.findById(key.user).select('roles plan planExpiresAt deletionScheduledFor');
    // A key whose account is gone or pending deletion is dead — same policy as
    // personal tokens and refresh sessions.
    if (!user || user.deletionScheduledFor) {
      return res.status(401).json({ error: 'Invalid or revoked bridge key', code: 'invalid_key' });
    }

    const planExpired = user.planExpiresAt && Date.now() > user.planExpiresAt.getTime();
    req.user = {
      id: user._id.toString(),
      roles: user.roles && user.roles.length > 0 ? user.roles : ['user'],
      plan: planExpired ? 'free' : (user.plan || 'free'),
      planExpiresAt: user.planExpiresAt || null,
    };
    req.bridge = {
      key: { id: key._id.toString(), name: key.name, prefix: key.prefix, instanceHost: key.instanceHost || null },
      keyDoc: key,
    };

    // Throttled bookkeeping — fire-and-forget, never blocks the request. The
    // instance host is refreshed on the same schedule; a changed host in
    // between is picked up within the hour.
    const host = instanceHostFrom(req);
    const stale = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS;
    if (stale) {
      const set = { lastUsedAt: new Date() };
      if (host && host !== key.instanceHost) set.instanceHost = host;
      BridgeKey.updateOne({ _id: key._id }, { $set: set }).catch(() => {});
      // Audit the key id, never the key itself.
      logAudit(req, 'bridge.key.used', { type: 'bridgeKey', id: key._id }, { instanceHost: host || key.instanceHost || null });
    }
    next();
  } catch (error) {
    console.error('Bridge key auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = { requireBridgeKey, isBridgeCredential, instanceHostFrom, LAST_USED_THROTTLE_MS };
