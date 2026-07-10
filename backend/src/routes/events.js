const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const eventBus = require('../services/eventBus');
const User = require('../models/User');
const ApiToken = require('../models/ApiToken');

// Stream lifetime and liveness (docs/ha-push-events.md §1):
// - heartbeat comment every 25 s — clients treat >90 s of silence as dead, and
//   nginx's proxy_read_timeout 120s would otherwise kill idle streams
// - hard cap 24 h per stream; the client reconnects
// - hourly revalidation: one cheap indexed read per stream per hour to catch
//   revocations the dropUser/dropToken hooks might have missed (deleted user,
//   revoked token). No bcrypt anywhere on this path.
const HEARTBEAT_MS = 25 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REVALIDATE_MS = 60 * 60 * 1000;

// GET /api/events/stream — Server-Sent Events push channel.
//
// Auth: the same requireAuth as the REST API — either a JWT access token or a
// `read`-scoped personal API token (the scope allowlist includes this route).
// The credential is validated AT CONNECT; the stream is deliberately NOT
// terminated when a 15-min JWT expires (that would force a bcrypt re-login
// every 15 min per household — worse than the polling this replaces). The
// stream carries no data, only "something changed" nudges; real reads still
// require a live credential. Force-close hooks (password change/reset, logout,
// account deletion, token revocation) plus the hourly revalidation bound the
// exposure.
router.get('/stream', requireAuth, (req, res) => {
  const tokenId = req.apiToken?.id || null;
  const registered = eventBus.register(req.user.id, res, tokenId);
  if (!registered.ok) {
    return res.status(429).json({ error: 'Too many event streams' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    // no-transform keeps the global compression() middleware away — it would
    // buffer the stream and frames would never flush
    'Cache-Control': 'no-cache, no-transform',
    // nginx: do not buffer this response (per-route; no nginx.conf change)
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');

  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(': hb\n\n'); } catch { /* close handler cleans up */ }
  }, HEARTBEAT_MS);

  const maxAge = setTimeout(() => {
    try { res.end(); } catch { /* already gone */ }
  }, MAX_AGE_MS);

  const revalidate = setInterval(async () => {
    try {
      const user = await User.findById(req.user.id).select('deletionScheduledFor').lean();
      if (!user || user.deletionScheduledFor) return res.end();
      if (tokenId) {
        const token = await ApiToken.findOne({ _id: tokenId, revokedAt: null }).select('_id').lean();
        if (!token) return res.end();
      }
    } catch { /* transient DB error — keep the stream, retry next hour */ }
  }, REVALIDATE_MS);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    clearInterval(revalidate);
    clearTimeout(maxAge);
    eventBus.unregister(req.user.id, res);
  };
  req.on('close', cleanup);
  // If the socket died while requireAuth awaited its DB lookups (the API-token
  // path awaits twice), 'close' fired BEFORE the listener above was attached
  // and will never re-fire — reap immediately or the registration + timers
  // leak until restart, and five such aborts fill the user's stream cap with
  // zombies (permanent 429 for the household).
  if (req.destroyed || res.destroyed || res.writableEnded) cleanup();
});

module.exports = router;
