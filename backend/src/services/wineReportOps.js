/**
 * Closing a wine report — ONE implementation shared by the admin REST queue
 * and the sommelier MCP tools, so the two surfaces cannot drift on what the
 * reporter is told, what is stored, or what gets audited.
 *
 * Why a notification at all: a report's status lives behind a tab on the
 * Support page, so before this a handled report and an ignored one looked
 * identical to the person who filed it. Every close notifies.
 *
 * Note the field name. `adminResponse` has always been rendered to the user,
 * while the admin form called it "internal notes, not shown to user" — an
 * admin taking that at its word could have published a candid note straight to
 * the reporter. There is no internal-notes counterpart: anything written here
 * is user-facing.
 */

const WineReport = require('../models/WineReport');
const { logAudit } = require('./audit');
const { stripHtml } = require('../utils/sanitize');
const { incrementCred } = require('../utils/cellarCred');
const { createNotification } = require('./notifications');
const { isValidId } = require('../utils/validation');

const MAX_RESPONSE = 2000;
const OUTCOMES = ['resolved', 'dismissed'];

function wineLabel(wine) {
  if (!wine || !wine.name) return 'a wine you reported';
  return `${wine.name}${wine.producer ? ` — ${wine.producer}` : ''}`;
}

function fallbackMessage(outcome, wine) {
  return outcome === 'resolved'
    ? `Thanks — your report on ${wineLabel(wine)} has been reviewed and the registry updated where needed.`
    : `Thanks for flagging ${wineLabel(wine)}. After review we left the record as it stands.`;
}

/**
 * Validate a user-facing reply on its own. Callers that mutate something else
 * first (the admin apply-suggestion path writes the wine before closing the
 * report) must run this BEFORE that write, or a rejected reply leaves the
 * registry edited and the report still open.
 *
 * @returns {{ok: true, text: string} | {ok: false, message: string}}
 */
function validateResponse(response) {
  if (response != null && typeof response !== 'string') {
    return { ok: false, message: 'Response must be text' };
  }
  const text = typeof response === 'string' ? response.trim() : '';
  if (text.length > MAX_RESPONSE) {
    return { ok: false, message: `Response must be ${MAX_RESPONSE} characters or fewer` };
  }
  return { ok: true, text };
}

/**
 * Close a pending wine report and tell its reporter.
 *
 * @param {object}  o
 * @param {string}  o.reportId
 * @param {string}  o.actorId    — the admin/somm closing it
 * @param {string}  o.outcome    — 'resolved' | 'dismissed'
 * @param {string} [o.response]  — user-facing reply; omitted/blank sends a plain acknowledgement
 * @param {object} [o.req]       — for logAudit; absent in tests/jobs
 * @param {string} [o.via]       — 'rest' | 'mcp', recorded on the audit entry
 * @param {object} [o.report]    — an already-loaded pending report, to avoid a second read
 * @returns {Promise<{ok: boolean, code?: string, message?: string, report?: object}>}
 */
async function closeWineReport({ reportId, actorId, outcome, response, req, via = 'rest', report: preloaded }) {
  if (!OUTCOMES.includes(outcome)) {
    return { ok: false, code: 'invalid_input', message: 'Outcome must be "resolved" or "dismissed"' };
  }
  const checked = validateResponse(response);
  if (!checked.ok) return { ok: false, code: 'invalid_input', message: checked.message };
  const text = checked.text;
  if (!preloaded && !isValidId(reportId)) {
    return { ok: false, code: 'invalid_input', message: 'Invalid report id' };
  }

  const report = preloaded || await WineReport.findById(reportId);
  if (!report) return { ok: false, code: 'not_found', message: 'Report not found' };
  if (report.status !== 'pending') {
    return { ok: false, code: 'conflict', message: 'Report is already resolved or dismissed' };
  }

  report.status = outcome;
  if (text) {
    report.adminResponse = stripHtml(text);
    report.respondedAt = new Date();
  }
  report.resolvedBy = actorId;
  report.resolvedAt = new Date();
  await report.save();

  if (outcome === 'resolved') {
    // Reporting a real defect earns curator cred — unchanged behaviour.
    incrementCred(report.user, 'wine_report_resolved').catch(() => {});
  }

  logAudit(req, `wine.report.${outcome}`, { type: 'WineReport', id: report._id }, {
    wineDefinitionId: report.wineDefinition,
    responded: !!report.adminResponse,
    via,
  });

  // Populate so the message can name the wine. After save, so a failed write
  // never produces a notification for a close that did not happen.
  await report.populate('user', 'username email');
  await report.populate('wineDefinition', 'name producer country type appellation');
  await report.populate('resolvedBy', 'username');

  const resolved = outcome === 'resolved';
  createNotification(
    report.user?._id || report.user,
    resolved ? 'wine_report_resolved' : 'wine_report_dismissed',
    resolved ? 'Wine report resolved' : 'Wine report reviewed',
    report.adminResponse || fallbackMessage(outcome, report.wineDefinition),
    '/support'
  );

  return { ok: true, report };
}

module.exports = { closeWineReport, validateResponse, MAX_RESPONSE, OUTCOMES };
