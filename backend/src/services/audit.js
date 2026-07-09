const pino = require('pino');
const AuditLog = require('../models/AuditLog');
const { getClientIp } = require('../utils/clientIp');

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
}

module.exports = { logAudit, logger };
