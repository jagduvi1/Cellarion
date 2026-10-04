const express = require('express');
const multer = require('multer');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const aiBurstLimiter = require('../middleware/aiBurstLimiter');
const { tryDebitAi, isRefundableScanError } = require('../services/aiBudget');
const { logAudit } = require('../services/audit');
const { prepareReceiptContent, readReceipt, buildReceiptResult, limits } = require('../services/receiptScan');
const { archiveReceiptScan } = require('../services/receiptArchive');

const router = express.Router();

// POST /api/bottles/import/receipt — read the wine lines off a receipt.
//
// Body: multipart/form-data, field `files`: up to five photos of one receipt
// (in order) or one PDF. Returns { receipt: { documentType, store,
// purchaseDate, currency }, items, skipped, warnings } — rows for the import
// page, which runs them through the normal validate → review → confirm flow.
// No bottle is created here. During the BETA every completed read — good,
// unreadable or "not a receipt" — is kept for a few days with the model's
// reply (services/receiptArchive) so a misread can be diagnosed; the import
// page says so before the user chooses a file. A call that never completed
// (no provider, transport error) is not kept: there is nothing to diagnose.
//
// requireNonDemo + tryDebitAi: a scan is one paid vision call, debited from
// the shared daily AI budget like a label scan, and refunded when the call
// never completed. aiBurstLimiter shares the per-user bucket with the other
// AI routes.

// One receipt at a time per user, and a small global ceiling, taken BEFORE
// multer buffers the upload (the cellar importer's audit lesson): a burst of
// concurrent uploads must be refused before each one holds its files in memory.
const GLOBAL_MAX_SCANS = 4;
const inFlight = new Set();

function gateScan(req, res, next) {
  const userId = String(req.user.id);
  if (inFlight.has(userId) || inFlight.size >= GLOBAL_MAX_SCANS) {
    res.set('Retry-After', '10');
    return res.status(429).json({ error: 'A receipt is already being read. Please try again in a few seconds.', code: 'scan_busy' });
  }
  inFlight.add(userId);
  let released = false;
  const release = () => { if (!released) { released = true; inFlight.delete(userId); } };
  res.on('finish', release);
  res.on('close', release);
  next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(limits.MAX_IMAGE_BYTES, limits.MAX_PDF_BYTES),
    files: limits.MAX_IMAGE_FILES,
  },
});

// multer errors (too large, too many files) become 400s, not 500s.
function handleUpload(req, res, next) {
  upload.array('files', limits.MAX_IMAGE_FILES)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'A file is too large (max 12 MB per photo, 10 MB per PDF).'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Upload at most ${limits.MAX_IMAGE_FILES} photos at a time.`
          : 'The upload could not be read.';
      return res.status(400).json({ error: msg, code: 'bad_upload' });
    }
    next();
  });
}

function sendBudgetRefusal(res, debit) {
  if (debit.reason === 'demo_disabled') {
    return res.status(403).json({
      error: 'AI features are not available in the demo. Create a free account to use them.',
      code: 'demo_ai_disabled',
    });
  }
  res.set('Retry-After', String(debit.retryAfterSeconds));
  return res.status(429).json({
    error: 'Daily AI budget reached. AI features reset at midnight UTC.',
    code: 'ai_budget_exhausted',
    scope: debit.reason,
    retryAfterSeconds: debit.retryAfterSeconds,
  });
}

router.post('/', requireAuth, requireNonDemo, aiBurstLimiter, gateScan, handleUpload, async (req, res) => {
  // Prepare before debiting: a file that cannot be read costs the user nothing.
  let content;
  try {
    content = await prepareReceiptContent(req.files);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message, code: err.code });
    console.error('Receipt prepare error:', err.message);
    return res.status(500).json({ error: 'The receipt could not be read.' });
  }

  let debit;
  try {
    debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
  } catch (err) {
    console.error('Receipt scan budget error:', err.message);
    return res.status(500).json({ error: 'The receipt could not be read.' });
  }
  if (!debit.ok) return sendBudgetRefusal(res, debit);

  // The billable call. Refund only when it produced no completion (no
  // provider configured, transport failure); a completed reply with no usable
  // JSON (422) stays debited — the same policy as the label scan.
  // Beta archive of a completed read (best-effort: never fails the request).
  const keep = (outcome, { raw, model, result = null }) => archiveReceiptScan({
    userId: req.user.id, files: content.archive, rawReply: raw, result, outcome, model, stats: content.stats,
  });

  let reply;
  try {
    reply = await readReceipt(content.blocks);
  } catch (err) {
    if (isRefundableScanError(err)) await debit.refund();
    if (err.status === 422) {
      await keep('unreadable', { raw: err.raw, model: err.model });
      return res.status(422).json({ error: err.message, code: err.code });
    }
    if (err.status === 503) {
      return res.status(503).json({ error: 'Reading receipts needs the AI service, which is not set up on this server.', code: 'ai_unavailable' });
    }
    console.error('Receipt scan error:', err.message);
    return res.status(502).json({ error: 'The receipt could not be read right now. Please try again.', code: 'ai_failed' });
  }

  let result;
  try {
    result = buildReceiptResult(reply.parsed);
  } catch (err) {
    if (err.status === 422) {
      await keep(err.code || 'unreadable', { raw: reply.raw, model: reply.model });
      return res.status(422).json({ error: err.message, code: err.code });
    }
    console.error('Receipt result error:', err.message);
    return res.status(500).json({ error: 'The receipt could not be read.' });
  }
  await keep('read', { raw: reply.raw, model: reply.model, result });

  // Counts only: the shop, the wines and the prices are the user's own data
  // and reach the audit trail when (and if) the import is confirmed.
  logAudit(req, 'import.receipt_scan', { type: 'user', id: req.user.id }, {
    pdf: content.stats.pdf,
    files: content.stats.files,
    images: content.stats.images,
    wineLines: result.items.length,
    bottles: result.items.reduce((sum, i) => sum + i.quantity, 0),
    skippedLines: result.skipped.length,
  });

  res.json(result);
});

module.exports = router;
module.exports._inFlightForTests = inFlight;
