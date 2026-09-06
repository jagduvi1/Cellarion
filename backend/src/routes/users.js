const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineRequest = require('../models/WineRequest');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const BottleImage = require('../models/BottleImage');
const Follow = require('../models/Follow');
const Recommendation = require('../models/Recommendation');
const JournalEntry = require('../models/JournalEntry');
const RestockAlert = require('../models/RestockAlert');
const PushSubscription = require('../models/PushSubscription');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const WineList = require('../models/WineList');
const PendingShare = require('../models/PendingShare');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const DiscussionReaction = require('../models/DiscussionReaction');
const DiscussionWatch = require('../models/DiscussionWatch');
const DiscussionRead = require('../models/DiscussionRead');
const DiscussionReport = require('../models/DiscussionReport');
const ChatUsage = require('../models/ChatUsage');
const ImportSession = require('../models/ImportSession');
const SupportTicket = require('../models/SupportTicket');
const WineReport = require('../models/WineReport');
const WishlistItem = require('../models/WishlistItem');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { updatePreferences, updateProfile } = require('../services/accountOps');
const { buildUserExport } = require('../services/userDataRegistry');
const { revokeAllSessions } = require('../services/authTokens');
const {
  buildCellarDataExport,
  IMAGE_EXPORT_COOLDOWN_MS,
  claimImageExportAllowance,
  refundImageExportAllowance,
  streamCellarArchive,
} = require('../services/cellarExport');
const { safeUploadPath } = require('../services/imageProcessor');
const { logAudit } = require('../services/audit');
const eventBus = require('../services/eventBus');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/clientIp');

// Audit 2026-09 D05-4: the full account export spans ~40 collections at up to
// 50k rows each and had no per-user throttle. Three an hour is more than any
// person needs and stops a looping script; keyed on the account so a shared
// address is not punished. Kept separate from the MCP export-link claim
// (lastAccountExportAt) so a web download never blocks a connector export.
const accountExportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : rateLimitKey(req)),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', { type: 'user', id: req.user?.id }, { limiter: 'accountExport', limit: 3 });
    res.status(429).json({ error: 'Account exports are limited to three per hour. Please try again later.' });
  },
});
const { CURRENT_PRIVACY_POLICY_VERSION } = require('../config/legal');
const { stripHtml, escapeRegex } = require('../utils/sanitize');
const { isValidId, coerceStringQuery } = require('../utils/validation');

const router = express.Router();

/**
 * Has this member published anything under their own name that other users can
 * already see? Used only to decide whether a PRIVATE profile answers with a
 * "this profile is private" stub or with the enumeration-proof 404.
 *
 * The three surfaces that render an author's username next to their content
 * and link it to /users/:id — discussions, replies and public reviews. A
 * soft-deleted reply doesn't count: its body is replaced with a placeholder
 * and the name goes with it. A review the author marked private doesn't count
 * either — same principle as the profile itself.
 *
 * Runs at most three indexed existence checks, and only on the private-profile
 * path, which is a small fraction of profile views.
 *
 * @param {mongoose.Types.ObjectId} userId
 * @returns {Promise<boolean>}
 */
async function hasPublicFootprint(userId) {
  const [discussion, reply, review] = await Promise.all([
    Discussion.exists({ author: userId }),
    DiscussionReply.exists({ author: userId, isDeleted: { $ne: true } }),
    Review.exists({ author: userId, visibility: 'public' }),
  ]);
  return !!(discussion || reply || review);
}

// GET /api/users/profile - Get current user's profile (protected)
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// POST /api/users/me/accept-policy - Record the user re-accepting the current
// privacy policy after a version bump (GDPR re-consent on material change).
router.post('/me/accept-policy', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Path-setter creates intermediate objects safely (a legacy user may have no
    // gdprConsent sub-document at all) and tracks the nested change for save().
    // A policy version bump also covers expanded data-processing terms (new
    // sub-processors), so refresh BOTH consents together — exactly as
    // registration stamps them — so the dataProcessing timestamp doesn't stay
    // frozen at the pre-update date and the consent record stays truthful.
    const now = new Date();
    user.set('gdprConsent.privacyPolicy.accepted', true);
    user.set('gdprConsent.privacyPolicy.acceptedAt', now);
    user.set('gdprConsent.privacyPolicy.version', CURRENT_PRIVACY_POLICY_VERSION);
    user.set('gdprConsent.dataProcessing.accepted', true);
    user.set('gdprConsent.dataProcessing.acceptedAt', now);
    await user.save();

    logAudit(req, 'user.policy.reconsent', { type: 'user', id: req.user.id },
      { version: CURRENT_PRIVACY_POLICY_VERSION });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Accept policy error:', error);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// PATCH /api/users/preferences - Update current user's preferences
// Validation allow-lists (currency source-of-truth = config/currencies.js) and
// persistence now live in services/accountOps so the MCP tool shares them.
router.patch('/preferences', requireAuth, async (req, res) => {
  try {
    // Validation + persistence live in services/accountOps so the MCP
    // update_preferences tool applies byte-for-byte the same rules.
    const { user, error } = await updatePreferences(req.user.id, req.body);
    if (error) return res.status(error.status).json({ error: error.message });
    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// PATCH /api/users/profile - Update display name, bio, and visibility
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    // Shared with the MCP update_profile tool via services/accountOps.
    const { user, error } = await updateProfile(req.user.id, req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    logAudit(req, 'user.profile.update', { type: 'user', id: user._id });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// GET /api/users/search - Search for public users by username or display name
router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = coerceStringQuery(req.query.q).trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }

    const regex = new RegExp(escapeRegex(q), 'i');
    const users = await User.find({
      profileVisibility: 'public',
      $or: [{ username: regex }, { displayName: regex }]
    })
      .select('username displayName bio reviewCount')
      .limit(20);

    // Check which the current user follows
    const userIds = users.map(u => u._id);
    const myFollows = await Follow.find({ follower: req.user.id, following: { $in: userIds } }).select('following');
    const followingSet = new Set(myFollows.map(f => f.following.toString()));

    const results = users.map(u => ({
      _id: u._id,
      username: u.username,
      displayName: u.displayName,
      bio: u.bio,
      reviewCount: u.reviewCount,
      isFollowing: followingSet.has(u._id.toString())
    }));

    res.json({ users: results });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Failed to search users' });
  }
});

// GET /api/users/public/:userId - Get public profile
router.get('/public/:userId', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid ID' });
    const user = await User.findById(req.params.userId)
      .select('username displayName bio followersCount followingCount reviewCount profileVisibility createdAt preferences.ratingScale contribution plan');

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Respect profileVisibility: a private profile is only viewable by its
    // owner. The /search sibling already filters on 'public'; this endpoint
    // must not become a private-profile read oracle by ObjectId enumeration.
    //
    // …with one exception, because the blanket 404 told a lie the rest of the
    // app contradicted: a forum post shows its author's username and links to
    // this page, so clicking a visible name answered "User not found" for 84
    // of 346 accounts (Johan, 2026-08-31). Where the member has ALREADY
    // published content under this identity, their existence is public by
    // their own action and the 404 protects nothing — so they get a stub
    // saying the profile is private, and nothing else. A member who never
    // posted stays fully indistinguishable from a non-existent id, which is
    // the enumeration property #519 actually bought.
    const isOwner = req.user.id === req.params.userId;
    if (user.profileVisibility === 'private' && !isOwner) {
      if (!(await hasPublicFootprint(user._id))) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Deliberately minimal: identity the viewer can already see, plus the
      // reason the rest is missing. No bio, counts, plan, contribution,
      // rating scale, join date or follow state — a private profile stays
      // private, it just stops pretending to be a dead link.
      return res.json({
        user: {
          _id: user._id,
          username: user.username,
          displayName: user.displayName,
          profileVisibility: 'private',
          isPrivate: true,
        },
      });
    }

    // Check if current user follows this user
    const isFollowing = !isOwner
      ? !!(await Follow.findOne({ follower: req.user.id, following: req.params.userId }))
      : false;

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        followersCount: user.followersCount,
        followingCount: user.followingCount,
        reviewCount: user.reviewCount,
        profileVisibility: user.profileVisibility,
        ratingScale: user.preferences?.ratingScale || '5',
        createdAt: user.createdAt,
        // Supporter-tier badge (2026-08-27): the paid plan is worn publicly as
        // a thank-you chip. Tier name only — never amounts or billing state.
        plan: user.plan || 'free',
        contribution: {
          totalScore: user.contribution?.totalScore || 0,
          tier: user.contribution?.tier || 'newcomer',
          specialty: user.contribution?.specialty || null,
          categories: user.contribution?.categories || {},
        },
        isFollowing
      }
    });
  } catch (error) {
    console.error('Get public profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// GET /api/users/me/export — GDPR data portability: export all user data as JSON
//
// Per-collection caps that bound worst-case memory live in
// services/userDataRegistry.js (EXPORT_MAX there) — the single source of
// truth shared with the deletion job. The admin user list lives at
// /api/admin/users (routes/admin/users.js).
router.get('/me/export', requireAuth, accountExportLimiter, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // All erasure/export coverage lives in the user-data registry (single
    // source of truth shared with the deletion job — see
    // services/userDataRegistry.js).
    const exportData = await buildUserExport(userId, user);
    // Audit 2026-09 S1-1: the cellar exports and the MCP twin already leave a
    // row; the one export that carries ALL of a person's data did not.
    logAudit(req, 'user.account_export', { type: 'user', id: userId }, {
      via: 'web', collections: Object.keys(exportData || {}).length, truncated: !!exportData?._truncated,
    });

    res.setHeader('Content-Disposition', `attachment; filename="cellarion-data-export-${user.username}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(exportData);
  } catch (error) {
    console.error('Data export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// ── Cellar portability export ────────────────────────────────────────────────
// "Take your cellars with you." A user can pull one owned cellar (or all of
// them) out of Cellarion as an import-ready document, optionally bundled with
// the image files they uploaded. Anti-lock-in, made concrete.
//
// Two endpoints share one builder:
//   /me/data-export   → JSON only, no rate limit (cheap)
//   /me/full-export   → ZIP (data.json + your own images + README), max 1×/week
// The weekly claim/refund + ZIP streaming live in services/cellarExport.js,
// shared with the MCP export-link redeem route.

// Parse the ?cellar= scope: 'all' (default) or a cellar ObjectId. Responds 400
// and returns null on a malformed id so the caller can bail.
function parseExportScope(req, res) {
  const raw = coerceStringQuery(req.query.cellar).trim();
  const scope = raw || 'all';
  if (scope !== 'all' && !isValidId(scope)) {
    res.status(400).json({ error: 'Invalid cellar id' });
    return null;
  }
  return scope;
}

// GET /api/users/me/data-export?cellar=<id|all> — cellar data as JSON (no files)
router.get('/me/data-export', requireAuth, async (req, res) => {
  const scope = parseExportScope(req, res);
  if (scope === null) return;
  try {
    const result = await buildCellarDataExport(req.user.id, scope);
    if (!result) return res.status(404).json({ error: 'No cellar found for that selection' });

    logAudit(req, 'user.cellar_data_export', { type: 'user', id: req.user.id }, { scope, bottles: result.payload.bottleCount });

    res.setHeader('Content-Disposition', 'attachment; filename="cellarion-data-export.json"');
    res.setHeader('Content-Type', 'application/json');
    res.json(result.payload);
  } catch (error) {
    console.error('Cellar data export error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// GET /api/users/me/full-export?cellar=<id|all> — ZIP of data + the user's own
// uploaded image files. Rate-limited to once per week (the archive can be large).
router.get('/me/full-export', requireAuth, async (req, res) => {
  const scope = parseExportScope(req, res);
  if (scope === null) return;
  // Claim bookkeeping hoisted out of the try so the catch can refund: a
  // transient build failure used to consume the weekly allowance and lock
  // the user out of full export for 7 days. The claim/refund/stream cores are
  // shared with the MCP export-link redeem route (services/cellarExport.js).
  let claimStamp = null;
  let claimedPrior;
  try {
    const claim = await claimImageExportAllowance(req.user.id);
    if (!claim.claimed) {
      if (claim.notFound) return res.status(404).json({ error: 'User not found' });
      return res.status(429).json({
        error: 'Full exports with images are limited to once per week.',
        nextAvailableAt: claim.nextAvailableAt,
      });
    }
    claimStamp = claim.claimStamp;
    claimedPrior = claim.priorStamp;

    const result = await buildCellarDataExport(req.user.id, scope);

    // Refund the allowance when there was nothing chargeable — no cellar, or a
    // data-only archive with no image files (preserving the prior "only count
    // exports that bundle images" behaviour).
    if (!result || result.imageCount === 0) {
      await refundImageExportAllowance(req.user.id, claimStamp, claimedPrior);
      claimStamp = null; // refunded — the catch must not double-refund
      if (!result) return res.status(404).json({ error: 'No cellar found for that selection' });
    }

    logAudit(req, 'user.full_export', { type: 'user', id: req.user.id }, { scope, images: result.imageCount });

    res.setHeader('Content-Disposition', 'attachment; filename="cellarion-export.zip"');
    res.setHeader('Content-Type', 'application/zip');
    await streamCellarArchive(res, result.payload, result.imageFiles);
  } catch (error) {
    console.error('Full export error:', error);
    // Refund the claimed allowance — guarded on our own timestamp so a later
    // legitimate claim is never clobbered (same guard as the empty-refund).
    await refundImageExportAllowance(req.user.id, claimStamp, claimedPrior)
      .catch(err => console.error('[full-export] refund failed:', err.message));
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export' });
  }
});

// GET /api/users/me/export-summary?cellar=<id|all> — a preview of exactly what an
// export of this scope contains (counts + image byte size) plus the weekly image-
// archive lock state. Powers the "see your total export" panel before download.
// Reuses buildCellarDataExport so the numbers always match the real download.
router.get('/me/export-summary', requireAuth, async (req, res) => {
  const scope = parseExportScope(req, res);
  if (scope === null) return;
  try {
    const user = await User.findById(req.user.id).select('lastImageExportAt');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await buildCellarDataExport(req.user.id, scope);
    if (!result) return res.status(404).json({ error: 'No cellar found for that selection' });
    const { payload } = result;

    // Rack count + how many cellars carry a 3D room layout, from the payload.
    let rackCount = 0;
    let layoutCount = 0;
    for (const c of payload.cellars) {
      rackCount += (c.racks || []).length;
      if (c.layout) layoutCount++;
    }

    // Sum on-disk bytes of the user's own image files (best-effort — a DB row can
    // outlive a missing file; safeUploadPath blocks traversal). Bounded by the
    // export's image cap.
    let imageBytes = 0;
    for (const file of result.imageFiles) {
      try {
        imageBytes += fs.statSync(safeUploadPath(file.relPath)).size;
      } catch { /* missing or blocked file — skip */ }
    }

    const nextAvailableAt = user.lastImageExportAt
      ? new Date(new Date(user.lastImageExportAt).getTime() + IMAGE_EXPORT_COOLDOWN_MS)
      : null;
    const imageExportLocked = !!nextAvailableAt && nextAvailableAt.getTime() > Date.now();

    res.json({
      scope: payload.scope,
      cellarCount: payload.cellarCount,
      bottleCount: payload.bottleCount,
      rackCount,
      layoutCount,
      reviewCount: payload.reviewCount,
      imageCount: payload.imageCount,
      maturityCount: payload.maturityCount,
      imageBytes,
      imageExportLocked,
      nextAvailableAt,
    });
  } catch (error) {
    console.error('Export summary error:', error);
    res.status(500).json({ error: 'Failed to summarise export' });
  }
});

// DELETE /api/users/me — schedule account deletion (7-day cooling-off period).
// requireNonDemo: demo accounts are throwaway and auto-expire via the reaper;
// the cooling-off deletion flow (and its email) makes no sense for them.
router.delete('/me', requireAuth, requireNonDemo, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.deletionScheduledFor) {
      return res.status(400).json({
        error: 'Account deletion already scheduled',
        deletionScheduledFor: user.deletionScheduledFor
      });
    }

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Cancel Stripe subscription immediately if active
    if (user.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(user.stripeSubscriptionId);
        user.stripeSubscriptionId = null;
        user.plan = 'free';
      } catch (stripeErr) {
        console.error('Failed to cancel Stripe subscription during deletion:', stripeErr.message);
      }
    }

    user.deletionRequestedAt = now;
    user.deletionScheduledFor = scheduledFor;
    // Revoke every device session on the deletion request so a refresh token
    // captured before deletion can't keep minting access tokens through the
    // 7-day window. The user simply re-authenticates to use the account (or to
    // cancel the deletion) — matching change-password / password-reset.
    revokeAllSessions(user);
    eventBus.dropUser(user._id); // and force-close open SSE event streams
    await user.save();

    // Clean up pending cellar invites sent by this user
    PendingShare.deleteMany({ invitedBy: userId }).catch(() => {});

    logAudit(req, 'user.deletion_requested', { type: 'user', id: user._id });

    res.json({
      message: 'Account deletion scheduled. Your account and all data will be permanently deleted in 7 days. You can cancel this from Settings.',
      deletionScheduledFor: scheduledFor
    });
  } catch (error) {
    console.error('Schedule deletion error:', error);
    res.status(500).json({ error: 'Failed to schedule deletion' });
  }
});

// POST /api/users/me/cancel-deletion — cancel a scheduled account deletion
router.post('/me/cancel-deletion', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!user.deletionScheduledFor) {
      return res.status(400).json({ error: 'No deletion scheduled' });
    }

    user.deletionRequestedAt = null;
    user.deletionScheduledFor = null;
    await user.save();

    logAudit(req, 'user.deletion_cancelled', { type: 'user', id: user._id });

    res.json({ message: 'Account deletion cancelled' });
  } catch (error) {
    console.error('Cancel deletion error:', error);
    res.status(500).json({ error: 'Failed to cancel deletion' });
  }
});

// GET /api/users/unsubscribe?token=:token — one-click email unsubscribe (no auth required)
router.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Unsubscribe token is required' });
  }

  try {
    const { verifyUnsubscribeToken } = require('../utils/unsubscribe');
    const userId = verifyUnsubscribeToken(token);

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid unsubscribe link' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ error: 'Invalid unsubscribe link' });
    }

    // Walk every notification category and flip its outbound channels
    // (email + push) to false. Earlier code assigned to non-existent
    // `notifications.email` / `notifications.push` paths — Mongoose's
    // strict mode silently dropped those writes and the user kept
    // receiving every category. See utils/notifications.js for the
    // canonical category list, and notifications.test.js for the
    // regression coverage that locks this in.
    const { unsubscribeAllNotifications } = require('../utils/notifications');
    const changed = unsubscribeAllNotifications(user);
    if (changed) {
      await user.save();
      logAudit(req, 'user.unsubscribe.all',
        { type: 'user', id: user._id },
        { username: user.username }
      );
    }

    // Redirect to a confirmation page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/unsubscribed`);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
