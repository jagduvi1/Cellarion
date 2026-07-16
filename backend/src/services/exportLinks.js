// Export-link service — mint and redeem the short-lived download URLs the MCP
// export tools hand back (plan §3.3 / §3.18). See models/ExportLink.js for the
// "why a link, not the bytes" rationale: an export is a file, not model context.
//
// One place owns the credential lifecycle so the tool (mint) and the redeem
// route (consume) can't drift on token format, hashing, or expiry.
const crypto = require('crypto');
const ExportLink = require('../models/ExportLink');
const User = require('../models/User');
const { logAudit } = require('./audit');
const {
  buildCellarDataExport,
  claimImageExportAllowance,
  refundImageExportAllowance,
  streamCellarArchive,
} = require('./cellarExport');
// buildUserExport lives in userDataRegistry, which top-requires services/search
// (the meilisearch ESM chain jest's CJS runtime can't parse). Lazy-require it
// inside the one function that uses it so requiring THIS module — from the MCP
// route and, transitively, a tool — never drags in that chain at parse time.
const buildUserExport = (...a) => require('./userDataRegistry').buildUserExport(...a);

const LINK_PREFIX = 'celx_';
// Links live an hour: long enough to open the message and click, short enough
// that a URL leaked into chat history / proxy logs is dead by the time anyone
// finds it. Redeemable more than once WITHIN the hour on purpose — a big ZIP
// that dies mid-download must be retryable; the window is the bound.
const LINK_TTL_MS = 60 * 60 * 1000;
// The heavy account export is throttled to once per day on the MCP path.
const ACCOUNT_EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function hashLinkToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** True for a string shaped like an export-link credential (celx_ + 64 hex). */
function isExportLinkToken(raw) {
  return typeof raw === 'string' && /^celx_[a-f0-9]{64}$/.test(raw);
}

/**
 * Mint a one-hour download link for `kind`.
 * @param {object} p
 * @param {string} p.userId
 * @param {'cellar_json'|'cellar_zip'|'account_json'} p.kind
 * @param {string} [p.cellarScope]  'all' or a cellar id (cellar_* kinds)
 * @param {import('mongoose').Types.ObjectId|null} [p.tokenId]  provenance
 * @param {string} p.baseUrl        origin for the absolute URL, no trailing slash
 * @returns {Promise<{url:string, expiresAt:Date}>}
 */
async function mintExportLink({ userId, kind, cellarScope = 'all', tokenId = null, baseUrl }) {
  const raw = LINK_PREFIX + crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  await ExportLink.create({
    user: userId,
    tokenHash: hashLinkToken(raw),
    kind,
    cellarScope,
    tokenId,
    expiresAt,
  });
  return { url: `${baseUrl}/api/mcp/export/${raw}`, expiresAt };
}

/**
 * Look up a live (unexpired) link by its raw token. Returns the ExportLink doc
 * or null. TTL cleanup is eventually-consistent, so the expiresAt check here is
 * the real guard, not the index.
 */
async function findLiveLink(raw) {
  if (!isExportLinkToken(raw)) return null;
  const link = await ExportLink.findOne({ tokenHash: hashLinkToken(raw) });
  if (!link) return null;
  if (link.expiresAt.getTime() <= Date.now()) return null;
  return link;
}

// One shared 404 for "link no longer resolves to a downloadable export" —
// identical wording to the route's not-found so a redeemer can't distinguish
// "unknown/expired token" from "token valid but the owner was since deleted"
// (no existence oracle; the deleted-owner case is a purge race anyway).
const GONE = { status: 404, error: 'This download link is invalid or has expired. Ask your AI to generate a new export.' };

/**
 * Redeem a link: build the export and stream/send it on `res`. Owns all
 * response writes on the success path. On a pre-send failure returns a
 * {status, error} the caller turns into JSON; once bytes stream it can only
 * tear the socket down (mirrors the web full-export route). `req` is the
 * (unauthenticated) redeem request — passed through only so the actual PII
 * download is audit-logged with the downloader's IP.
 *
 * @returns {Promise<{status:number, error:string}|null>} null once handled
 */
async function redeemExportLink(link, res, req = null) {
  const user = await User.findById(link.user).select('username lastAccountExportAt lastImageExportAt');
  if (!user) return GONE;

  // Record the DOWNLOAD, not just the mint: a link is a shareable credential
  // and this is the point the data actually leaves us (CLAUDE.md GDPR — log
  // significant data processing). Actor is whoever holds the link (anonymous +
  // IP); the resource is the owning account.
  const auditDownload = () =>
    logAudit(req, 'user.export_download', { type: 'user', id: String(link.user) }, { kind: link.kind, via: 'mcp_link' });

  const markUsed = () =>
    ExportLink.updateOne({ _id: link._id }, { $set: { usedAt: new Date() }, $inc: { downloads: 1 } })
      .catch(() => {});

  if (link.kind === 'cellar_json') {
    const result = await buildCellarDataExport(link.user, link.cellarScope);
    if (!result) return { status: 404, error: 'No cellar found for that selection' };
    await markUsed();
    auditDownload();
    res.setHeader('Content-Disposition', 'attachment; filename="cellarion-data-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(result.payload);
    return null;
  }

  if (link.kind === 'account_json') {
    // Throttle the heavy build (once/day) — atomic conditional claim so two
    // concurrent redeems can't both run it. Unlike the cellar ZIP there is no
    // partial-file refund path: the whole JSON is built in memory then sent.
    const now = new Date();
    const cutoff = new Date(now.getTime() - ACCOUNT_EXPORT_COOLDOWN_MS);
    const claimed = await User.findOneAndUpdate(
      { _id: link.user, $or: [{ lastAccountExportAt: null }, { lastAccountExportAt: { $lte: cutoff } }] },
      { $set: { lastAccountExportAt: now } },
      { new: false }
    );
    if (!claimed) {
      const next = new Date(new Date(user.lastAccountExportAt).getTime() + ACCOUNT_EXPORT_COOLDOWN_MS);
      return { status: 429, error: `Account export is limited to once per day. Try again after ${next.toISOString()}.` };
    }
    try {
      const full = await User.findById(link.user);
      if (!full) return GONE;
      const exportData = await buildUserExport(link.user, full);
      await markUsed();
      auditDownload();
      res.setHeader('Content-Disposition', `attachment; filename="cellarion-data-export-${full.username}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(exportData);
      return null;
    } catch (err) {
      // Refund the daily claim so a transient failure doesn't lock the user out.
      await User.updateOne(
        { _id: link.user, lastAccountExportAt: now },
        { $set: { lastAccountExportAt: claimed.lastAccountExportAt } }
      ).catch(() => {});
      throw err;
    }
  }

  if (link.kind !== 'cellar_zip') {
    // Unreachable in practice (kind is an enum set server-side at mint), but an
    // explicit reject beats a silent fall-through if a new kind is ever added.
    return { status: 400, error: 'Unsupported export kind.' };
  }

  // cellar_zip — the expensive image archive. Shares the weekly allowance with
  // the web full-export route (MCP is not a bypass).
  let claimStamp = null;
  let claimedPrior;
  try {
    const claim = await claimImageExportAllowance(link.user);
    if (!claim.claimed) {
      if (claim.notFound) return GONE;
      return { status: 429, error: `Full ZIP export is limited to once per week. Try again after ${claim.nextAvailableAt.toISOString()}.` };
    }
    claimStamp = claim.claimStamp;
    claimedPrior = claim.priorStamp;

    const result = await buildCellarDataExport(link.user, link.cellarScope);
    if (!result || result.imageCount === 0) {
      await refundImageExportAllowance(link.user, claimStamp, claimedPrior);
      claimStamp = null;
      if (!result) return { status: 404, error: 'No cellar found for that selection' };
    }
    // If the client disconnects mid-stream, refund the weekly allowance so the
    // still-valid link stays retryable (streamCellarArchive resolves on a clean
    // 'end'; a premature socket close would otherwise leave the allowance spent
    // and re-clicking the link would 429). Guarded on our own claim stamp, and
    // idempotent with the catch refund below (a refunded stamp is a no-op).
    if (claimStamp) {
      const stamp = claimStamp;
      const prior = claimedPrior;
      res.on('close', () => {
        if (!res.writableEnded) refundImageExportAllowance(link.user, stamp, prior).catch(() => {});
      });
    }
    await markUsed();
    auditDownload();
    res.setHeader('Content-Disposition', 'attachment; filename="cellarion-export.zip"');
    res.setHeader('Content-Type', 'application/zip');
    await streamCellarArchive(res, result.payload, result.imageFiles);
    return null;
  } catch (err) {
    await refundImageExportAllowance(link.user, claimStamp, claimedPrior).catch(() => {});
    if (res.headersSent) { res.destroy(err); return null; }
    throw err;
  }
}

module.exports = {
  LINK_PREFIX,
  LINK_TTL_MS,
  ACCOUNT_EXPORT_COOLDOWN_MS,
  isExportLinkToken,
  hashLinkToken,
  mintExportLink,
  findLiveLink,
  redeemExportLink,
};
