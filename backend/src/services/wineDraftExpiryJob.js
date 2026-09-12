/**
 * Private-draft expiry sweep — runs hourly via the scheduler (a daily job
 * could not honour a 24-hour warning).
 *
 * models/WineDefinition.draftExpiresAt is the 7-day UNTOUCHED clock: every
 * edit and every bottle add restarts it (services/wineDraftOps.touchDraft).
 * When it lapses:
 *   • an EMPTY draft (no bottles) is deleted — a staging area nobody clears
 *     becomes a second cellar, and re-adding a wine that was never finished
 *     costs nothing. Its creator is told 24 h before (draftExpiryWarnedAt
 *     records that; a touch clears it so a revived draft is warned again).
 *   • a draft HOLDING bottles is never deleted — a lost bottle is worse than
 *     a half-finished record — it auto-publishes as it stands. If publish
 *     finds the wine already in the registry, the bottles are attached to it
 *     instead. Either way the creator is notified.
 *
 * GDPR: retention with a purpose and a bound; drafts are the user's own data
 * (exported by services/userDataRegistry, handled on account deletion there).
 *
 * Same TOCTOU-safe shape as the label-scan sweep: the selection predicate is
 * repeated in each write, so a draft touched between the read and the write
 * is skipped rather than acted on out from under its creator. Bounded per
 * run; the next run picks up the rest. One failing row never stops the sweep.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { createNotification } = require('./notifications');

const SWEEP_LIMIT = 200;
const DRAFTS_LINK = '/wine-drafts';

const label = (w) => (w.producer ? `${w.producer} — ${w.name}` : w.name);

async function notify(userId, type, title, message) {
  try {
    await createNotification(userId, type, title, message, DRAFTS_LINK);
  } catch (err) {
    console.warn('[wineDraftExpiryJob] notification failed (non-fatal):', err.message);
  }
}

async function runWineDraftExpirySweep(now = new Date()) {
  const ops = require('./wineDraftOps');
  const result = { warned: 0, deleted: 0, published: 0, merged: 0, errors: 0 };

  // ── Warn: empty drafts lapsing within the next 24 h, not yet warned ──
  const soon = new Date(now.getTime() + ops.DRAFT_WARN_HOURS * 60 * 60 * 1000);
  // Drafts holding bottles are never deleted, so they are never warned — and
  // they must not occupy the window either (audit 2026-09-12): a few hundred
  // bottle-holding drafts in the 24 h band would otherwise fill SWEEP_LIMIT
  // every hour and starve the empty ones the warning exists for.
  const inWindow = await WineDefinition.find({
    draft: true, draftExpiresAt: { $lte: soon, $gt: now }, draftExpiryWarnedAt: null,
  }).select('_id').limit(SWEEP_LIMIT * 5).lean();
  const held = new Set((await Bottle.distinct('wineDefinition', { wineDefinition: { $in: inWindow.map((w) => w._id) } })).map(String));
  const emptyIds = inWindow.map((w) => w._id).filter((id) => !held.has(String(id))).slice(0, SWEEP_LIMIT);
  const toWarn = emptyIds.length
    ? await WineDefinition.find({ _id: { $in: emptyIds }, draft: true, draftExpiryWarnedAt: null })
      .select('name producer createdBy draftExpiresAt').lean()
    : [];
  for (const w of toWarn) {
    try {
      // Re-checked at write time: a bottle added since the scan cancels the warning.
      if (await Bottle.exists({ wineDefinition: w._id })) continue;
      await notify(w.createdBy, 'wine_draft_expiring',
        'A draft wine is about to expire',
        `Your draft "${label(w)}" has no bottles and will be deleted in about a day. Add a bottle, edit it, or publish it to keep it.`);
      await WineDefinition.updateOne(
        { _id: w._id, draft: true, draftExpiryWarnedAt: null },
        { $set: { draftExpiryWarnedAt: now } }
      );
      result.warned += 1;
    } catch (err) {
      result.errors += 1;
      console.warn('[wineDraftExpiryJob] warn failed for', String(w._id), err.message);
    }
  }

  // ── Expire: clocks that have lapsed ──
  const lapsed = await WineDefinition.find({ draft: true, draftExpiresAt: { $lte: now } })
    .sort({ draftExpiresAt: 1 }).limit(SWEEP_LIMIT);
  for (const wine of lapsed) {
    try {
      const hasBottles = await Bottle.exists({ wineDefinition: wine._id });
      if (!hasBottles) {
        const d = await ops.deleteDraft(wine, null, { action: 'wine.draft_expire' });
        // A bottle arriving mid-sweep keeps the draft (conflict) — not an error.
        if (d.ok) result.deleted += 1; else if (d.code !== 'conflict') result.errors += 1;
        continue;
      }
      const creator = String(wine.createdBy);
      const r = await ops.publishDraft(wine, { userId: creator, req: null, auto: true, reason: 'expiry' });
      if (r.ok) {
        await notify(creator, 'wine_draft_published',
          'Your draft wine was published',
          `"${label(wine)}" sat untouched for ${ops.DRAFT_TTL_DAYS} days and has been published to the registry as it stood${r.pendingCuration ? ' (a curator will complete its producer)' : ''}.`);
        result.published += 1;
      } else if (r.code === 'duplicate' && r.match) {
        const a = await ops.attachDraftBottles(wine, r.match.wine_id, { userId: creator, roles: [], req: null, auto: true, reason: 'expiry' });
        if (a.ok) {
          await notify(creator, 'wine_draft_merged',
            'Your draft matched a registry wine',
            `"${label(wine)}" sat untouched for ${ops.DRAFT_TTL_DAYS} days; the registry already held it, so your ${a.bottlesMoved} bottle(s) now sit on "${r.match.producer ? `${r.match.producer} — ` : ''}${r.match.name}".`);
          result.merged += 1;
        } else {
          result.errors += 1;
          console.warn('[wineDraftExpiryJob] attach failed for', String(wine._id), a.message);
        }
      } else {
        result.errors += 1;
        console.warn('[wineDraftExpiryJob] auto-publish failed for', String(wine._id), r.code, r.message);
      }
    } catch (err) {
      result.errors += 1;
      console.warn('[wineDraftExpiryJob] expire failed for', String(wine._id), err.message);
    }
  }

  return result;
}

module.exports = { runWineDraftExpirySweep, SWEEP_LIMIT };
