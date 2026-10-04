/**
 * Receipt-scan BETA archive: keep each scanned receipt for a few days so a
 * misread can be diagnosed, then delete it — file and record.
 *
 * Files live in UPLOAD_DIR/receipts, a folder the static uploads route refuses
 * (middleware/uploadsStatic), so a stored receipt is never reachable by URL.
 * Everything here is best-effort: archiving must never fail or slow a scan the
 * user is waiting for.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ReceiptScan = require('../models/ReceiptScan');
const { UPLOAD_DIR } = require('../config/upload');

const RECEIPT_RETENTION_DAYS = 5;
const RETENTION_MS = RECEIPT_RETENTION_DAYS * 86400000;
const RAW_REPLY_MAX = 50000;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const receiptsDir = () => process.env.RECEIPTS_DIR || path.join(UPLOAD_DIR, 'receipts');

/**
 * @param {object} p
 * @param {string} p.userId
 * @param {{ buffer: Buffer, mediaType: string }[]} p.files  what was uploaded (photos already metadata-stripped)
 * @param {string} [p.rawReply]   the model's reply text
 * @param {object|null} [p.result] the cleaned result returned to the user
 * @param {string} p.outcome      'read' | 'unreadable' | 'not_a_receipt'
 * @param {string} [p.model]
 * @param {object} [p.stats]
 * @returns {Promise<object|null>} the stored record, or null when archiving failed
 */
async function archiveReceiptScan({ userId, files = [], rawReply = '', result = null, outcome, model, stats = {}, now = new Date() }) {
  const written = [];
  try {
    const dir = receiptsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    for (const f of files) {
      if (!Buffer.isBuffer(f.buffer) || f.buffer.length === 0) continue;
      const name = `${crypto.randomUUID()}.${EXT[f.mediaType] || 'bin'}`;
      await fs.promises.writeFile(path.join(dir, name), f.buffer, { mode: 0o600 });
      written.push({ name, mediaType: f.mediaType, bytes: f.buffer.length });
    }
    return await ReceiptScan.create({
      user: userId,
      files: written,
      model,
      rawReply: String(rawReply || '').slice(0, RAW_REPLY_MAX),
      result,
      outcome,
      stats,
      retainUntil: new Date(now.getTime() + RETENTION_MS),
      createdAt: now,
    });
  } catch (err) {
    console.warn('[receiptArchive] could not keep the receipt (non-fatal):', err.message);
    // A record that failed must not leave its files behind.
    await removeFiles(written.map((w) => w.name));
    return null;
  }
}

async function removeFiles(names) {
  const dir = receiptsDir();
  for (const name of names) {
    // Names are ours (uuid.ext) — basename() guards against anything else.
    await fs.promises.unlink(path.join(dir, path.basename(name))).catch(() => {});
  }
}

async function deleteScans(filter) {
  const scans = await ReceiptScan.find(filter).select('files').lean();
  for (const s of scans) await removeFiles((s.files || []).map((f) => f.name));
  if (scans.length) await ReceiptScan.deleteMany({ _id: { $in: scans.map((s) => s._id) } });
  return scans.length;
}

/**
 * Hourly: delete every receipt past its retention, record and files, then any
 * file in the folder older than the retention that no record points to (a
 * crash between write and save, or a record the TTL backstop removed first).
 */
async function runReceiptRetentionSweep({ now = new Date() } = {}) {
  const deleted = await deleteScans({ retainUntil: { $lte: now } });
  let orphans = 0;
  try {
    const dir = receiptsDir();
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const name of names) {
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (stat && stat.isFile() && now.getTime() - stat.mtimeMs > RETENTION_MS) {
        await fs.promises.unlink(path.join(dir, name)).catch(() => {});
        orphans += 1;
      }
    }
  } catch (err) {
    console.warn('[receiptArchive] orphan sweep failed:', err.message);
  }
  if (deleted || orphans) console.log(`[receiptArchive] deleted ${deleted} expired receipt(s), ${orphans} orphaned file(s)`);
  return { deleted, orphans };
}

/** Account deletion: every receipt of the user, files first. */
function purgeUserReceiptScans(userId) {
  return deleteScans({ user: userId });
}

module.exports = { archiveReceiptScan, runReceiptRetentionSweep, purgeUserReceiptScans, RECEIPT_RETENTION_DAYS, receiptsDir };
