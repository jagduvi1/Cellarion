const pino = require('pino');
const AuditLog = require('../models/AuditLog');
const { getClientIp } = require('../utils/clientIp');
const eventBus = require('./eventBus');

// SSE nudges (docs/ha-push-events.md §1): audit is the one funnel every
// significant mutation already flows through on its success path, so it doubles
// as the stats_changed emitter — a new bottle/cellar route gets push support by
// following the existing "audit your mutations" rule, with no second hook to
// forget. Only actions in these categories are user-visible wine-data changes;
// the emit targets the acting user (each account watches its own stream).
const STATS_CHANGED_PREFIXES = ['bottle.', 'cellar.'];

// Structured logger — outputs newline-delimited JSON to stdout.
// In Docker this is captured by the container runtime.
// Use pino-pretty in development: node server.js | pino-pretty
const logger = pino({
  name: 'audit',
  level: process.env.LOG_LEVEL || 'info'
});

/**
 * Fire-and-forget audit log entry.
 *
 * @param {object|null} req - Express request (for actor + userAgent). Pass
 *                            null for system-initiated events with no request
 *                            (e.g. Stripe webhooks, scheduled jobs) — the actor
 *                            is then recorded as 'system'.
 * @param {string} action - Dot-separated action name, e.g. 'bottle.add'
 * @param {object} resource - { type, id, cellarId } — what was acted on
 * @param {object} detail   - Action-specific payload (wineName, email, etc.)
 */
function logAudit(req, action, resource = {}, detail = {}) {
  const entry = {
    actor: {
      userId:    req?.user?.id    || null,
      role:      req?.user?.roles?.[0]  || (req ? 'anonymous' : 'system'),
      ipAddress: getClientIp(req)
    },
    action,
    resource,
    detail,
    userAgent: req?.headers?.['user-agent']
  };

  // Structured stdout log — visible in docker logs. REDACTED (L-16): the
  // container/log-aggregation stream is an independent copy of the audit trail
  // with no TTL and no erasure path, so it must never carry identifiers. Only
  // actor userId + role, the action, and the resource type/ids are emitted
  // (pino stamps the timestamp). actor.ipAddress, the userAgent, and every
  // detail field (username/email/sharedWith/invitedEmail, …) stay ONLY in the
  // MongoDB copy below, which is TTL'd and scrubbed on account erasure. The
  // redacted object is built by explicit field pick — not by deleting keys —
  // so no nested detail field can leak through a missed path.
  logger.info({
    actor: { userId: entry.actor.userId, role: entry.actor.role },
    action,
    resource: {
      type: resource.type ?? null,
      id: resource.id ?? null,
      cellarId: resource.cellarId ?? null,
    },
  }, action);

  // Persist to MongoDB asynchronously — never blocks the response
  AuditLog.create(entry).catch(err =>
    logger.error({ err }, 'Failed to persist audit log entry')
  );

  // SSE push nudge — debounced in the bus, no-op when the user has no open
  // stream. System-actor events (req = null, e.g. retention jobs) are skipped:
  // there is no acting user to notify.
  if (entry.actor.userId && STATS_CHANGED_PREFIXES.some(p => action.startsWith(p))) {
    eventBus.emit(entry.actor.userId, 'stats_changed', { reason: action });

    // Shared cellars: /api/stats aggregates the OWNER's bottles, so when a
    // member (or an admin) mutates a bottle, it is the owner's stats that
    // changed — nudge them too. Prefer the cellar requireBottleAccess already
    // loaded onto the request; otherwise resolve the owner from the audited
    // cellarId, but only when anyone is connected at all (skips the extra read
    // on instances with no push clients).
    const ownerFromReq = req?.cellar?.user;
    if (ownerFromReq) {
      if (String(ownerFromReq) !== String(entry.actor.userId)) {
        eventBus.emit(ownerFromReq, 'stats_changed', { reason: action });
      }
    } else if (resource.cellarId && eventBus.streamCounts().total > 0) {
      // Cast-guard before querying: every caller passes a document ObjectId
      // today, but logAudit is a generic funnel — accept only a plain 24-hex
      // id so no query-operator object can ever reach the lookup.
      const cellarId = String(resource.cellarId);
      if (/^[a-f0-9]{24}$/i.test(cellarId)) {
        const Cellar = require('../models/Cellar');
        Cellar.findById(cellarId).select('user').lean()
          .then(cellar => {
            if (cellar && String(cellar.user) !== String(entry.actor.userId)) {
              eventBus.emit(cellar.user, 'stats_changed', { reason: action });
            }
          })
          .catch(() => {});
      }
    }
  }
}

module.exports = { logAudit, logger };
