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
 * @param {object} req   - Express request (for actor + userAgent)
 * @param {string} action - Dot-separated action name, e.g. 'bottle.add'
 * @param {object} resource - { type, id, cellarId } — what was acted on
 * @param {object} detail   - Action-specific payload (wineName, email, etc.)
 */
function logAudit(req, action, resource = {}, detail = {}) {
  const entry = {
    actor: {
      userId:    req.user?.id    || null,
      role:      req.user?.roles?.[0]  || 'anonymous',
      ipAddress: getClientIp(req)
    },
    action,
    resource,
    detail,
    userAgent: req.headers?.['user-agent']
  };

  // Structured stdout log — visible in docker logs
  logger.info(entry, action);

  // Persist to MongoDB asynchronously — never blocks the response
  AuditLog.create(entry).catch(err =>
    logger.error({ err }, 'Failed to persist audit log entry')
  );
}

module.exports = { logAudit, logger };
