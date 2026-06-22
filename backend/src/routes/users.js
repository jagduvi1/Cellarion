const express = require('express');
const fs = require('fs');
const archiver = require('archiver');
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
const { requireAuth, requireRole } = require('../middleware/auth');
const { buildUserExport } = require('../services/userDataRegistry');
const { buildCellarDataExport, EXPORT_README } = require('../services/cellarExport');
const { safeUploadPath } = require('../services/imageProcessor');
const { logAudit } = require('../services/audit');
const { stripHtml, escapeRegex } = require('../utils/sanitize');
const { isValidId, coerceStringQuery } = require('../utils/validation');

const router = express.Router();

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

// PATCH /api/users/preferences - Update current user's preferences
const ALLOWED_CURRENCIES = ['USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'CAD', 'AUD'];
const ALLOWED_LANGUAGES = ['en', 'sv'];
const ALLOWED_RATING_SCALES = ['5', '20', '100'];
const ALLOWED_RACK_NAV = ['auto', 'room', 'rack'];

router.patch('/preferences', requireAuth, async (req, res) => {
  try {
    const { currency, language, ratingScale, rackNavigation, restockScope, defaultCellarId, notifications } = req.body;
    const update = {};

    // Notifications schema is per-category × per-channel (see User.js).
    // Accepted leaves are explicitly allow-listed so a malicious client can't
    // inject arbitrary keys into preferences.notifications.
    if (notifications !== undefined && typeof notifications === 'object') {
      const setLeaf = (path, value) => {
        update[`preferences.notifications.${path}`] = !!value;
      };
      const dw = notifications.drinkWindow;
      if (dw && typeof dw === 'object') {
        if (dw.enabled !== undefined) setLeaf('drinkWindow.enabled', dw.enabled);
        if (dw.email   !== undefined) setLeaf('drinkWindow.email', dw.email);
        if (dw.push    !== undefined) setLeaf('drinkWindow.push', dw.push);
      }
      const cr = notifications.communityReply;
      if (cr && typeof cr === 'object') {
        if (cr.email !== undefined) setLeaf('communityReply.email', cr.email);
        if (cr.push  !== undefined) setLeaf('communityReply.push', cr.push);
      }
      const cm = notifications.communityMention;
      if (cm && typeof cm === 'object') {
        if (cm.email !== undefined) setLeaf('communityMention.email', cm.email);
        if (cm.push  !== undefined) setLeaf('communityMention.push', cm.push);
      }
      const cf = notifications.communityFollow;
      if (cf && typeof cf === 'object') {
        if (cf.push !== undefined) setLeaf('communityFollow.push', cf.push);
      }
    }

    if (currency !== undefined) {
      if (!ALLOWED_CURRENCIES.includes(currency.toUpperCase())) {
        return res.status(400).json({ error: `Invalid currency. Allowed: ${ALLOWED_CURRENCIES.join(', ')}` });
      }
      update['preferences.currency'] = currency.toUpperCase();
    }

    if (language !== undefined) {
      if (!ALLOWED_LANGUAGES.includes(language)) {
        return res.status(400).json({ error: `Invalid language. Allowed: ${ALLOWED_LANGUAGES.join(', ')}` });
      }
      update['preferences.language'] = language;
    }

    if (ratingScale !== undefined) {
      if (!ALLOWED_RATING_SCALES.includes(String(ratingScale))) {
        return res.status(400).json({ error: `Invalid rating scale. Allowed: ${ALLOWED_RATING_SCALES.join(', ')}` });
      }
      update['preferences.ratingScale'] = String(ratingScale);
    }

    if (rackNavigation !== undefined) {
      if (!ALLOWED_RACK_NAV.includes(rackNavigation)) {
        return res.status(400).json({ error: `Invalid rack navigation. Allowed: ${ALLOWED_RACK_NAV.join(', ')}` });
      }
      update['preferences.rackNavigation'] = rackNavigation;
    }

    if (restockScope !== undefined) {
      if (!['all', 'cellar'].includes(restockScope)) {
        return res.status(400).json({ error: 'Invalid restock scope. Allowed: all, cellar' });
      }
      update['preferences.restockScope'] = restockScope;
    }

    if (defaultCellarId !== undefined) {
      if (defaultCellarId === null) {
        update['preferences.defaultCellarId'] = null;
      } else {
        if (!mongoose.Types.ObjectId.isValid(defaultCellarId)) {
          return res.status(400).json({ error: 'Invalid cellar ID' });
        }
        const cellar = await Cellar.findOne({
          _id: defaultCellarId,
          deletedAt: null,
          $or: [{ user: req.user.id }, { 'members.user': req.user.id }]
        });
        if (!cellar) {
          return res.status(400).json({ error: 'Cellar not found or not accessible' });
        }
        update['preferences.defaultCellarId'] = defaultCellarId;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid preferences provided' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user: user.toJSON() });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// PATCH /api/users/profile - Update display name, bio, and visibility
router.patch('/profile', requireAuth, async (req, res) => {
  try {
    const { displayName, bio, profileVisibility } = req.body;
    const update = {};

    if (displayName !== undefined) {
      const cleaned = stripHtml(displayName);
      if (cleaned && cleaned.length > 50) {
        return res.status(400).json({ error: 'Display name too long (max 50 characters)' });
      }
      update.displayName = cleaned || null;
    }

    if (bio !== undefined) {
      const cleaned = stripHtml(bio);
      if (cleaned && cleaned.length > 500) {
        return res.status(400).json({ error: 'Bio too long (max 500 characters)' });
      }
      update.bio = cleaned || null;
    }

    if (profileVisibility !== undefined) {
      if (!['public', 'private'].includes(profileVisibility)) {
        return res.status(400).json({ error: 'Invalid visibility. Allowed: public, private' });
      }
      update.profileVisibility = profileVisibility;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $set: update },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

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
      .select('username displayName bio followersCount followingCount reviewCount profileVisibility createdAt preferences.ratingScale contribution');

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Respect profileVisibility: a private profile is only viewable by its
    // owner. The /search sibling already filters on 'public'; this endpoint
    // must not become a private-profile read oracle by ObjectId enumeration.
    const isOwner = req.user.id === req.params.userId;
    if (user.profileVisibility === 'private' && !isOwner) {
      return res.status(404).json({ error: 'User not found' });
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

// GET /api/users/all - Get all users (admin only, paginated)
router.get('/all', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = {};
    if (search) {
      const escaped = escapeRegex(search);
      filter.$or = [
        { username: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } }
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('username email roles plan createdAt emailVerified')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter)
    ]);

    res.json({
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      users
    });
  } catch (error) {
    console.error('Get all users error:', error);
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// GET /api/users/me/export — GDPR data portability: export all user data as JSON
//
// Per-collection cap (EXPORT_MAX) bounds worst-case memory if a power user has
// pathological collection sizes. 50k is generous — a serious collector has
// ~5-10k bottles, and even the busiest discussion participant has < 5k replies.
// AuditLog has a tighter cap (1000) because it's high-cardinality activity log.
const EXPORT_MAX = 50000;
router.get('/me/export', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // All erasure/export coverage lives in the user-data registry (single
    // source of truth shared with the deletion job — see
    // services/userDataRegistry.js).
    const exportData = await buildUserExport(userId, user);

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
const IMAGE_EXPORT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

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
  try {
    // Atomically CLAIM the weekly allowance before the expensive build, so two
    // concurrent requests (double-click / refresh) can't both pass a check and
    // kick off two large archive builds. The conditional matches only when no
    // image export has run inside the window; a null result means the slot is
    // already taken (or the user is gone). This replaces a non-atomic
    // check-then-set that was bypassable under concurrency.
    const now = new Date();
    const cutoff = new Date(now.getTime() - IMAGE_EXPORT_COOLDOWN_MS);
    const claimed = await User.findOneAndUpdate(
      { _id: req.user.id, $or: [{ lastImageExportAt: null }, { lastImageExportAt: { $lte: cutoff } }] },
      { $set: { lastImageExportAt: now } },
      { new: false } // pre-update doc, so we can read (and refund) the prior timestamp
    );
    if (!claimed) {
      const u = await User.findById(req.user.id).select('lastImageExportAt');
      if (!u) return res.status(404).json({ error: 'User not found' });
      return res.status(429).json({
        error: 'Full exports with images are limited to once per week.',
        nextAvailableAt: new Date(new Date(u.lastImageExportAt).getTime() + IMAGE_EXPORT_COOLDOWN_MS),
      });
    }

    const result = await buildCellarDataExport(req.user.id, scope);

    // Refund the allowance when there was nothing chargeable — no cellar, or a
    // data-only archive with no image files (preserving the prior "only count
    // exports that bundle images" behaviour). Guarded on our own timestamp so a
    // later legitimate claim is never clobbered.
    if (!result || result.imageCount === 0) {
      await User.updateOne(
        { _id: req.user.id, lastImageExportAt: now },
        { $set: { lastImageExportAt: claimed.lastImageExportAt } }
      );
      if (!result) return res.status(404).json({ error: 'No cellar found for that selection' });
    }

    logAudit(req, 'user.full_export', { type: 'user', id: req.user.id }, { scope, images: result.imageCount });

    res.setHeader('Content-Disposition', 'attachment; filename="cellarion-export.zip"');
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') console.warn('[full-export] archive warning:', err.message);
    });
    archive.on('error', (err) => {
      console.error('[full-export] archive error:', err.message);
      // Headers are already sent once piping starts, so we can only tear down.
      if (!res.headersSent) res.status(500).json({ error: 'Failed to build archive' });
      else res.destroy(err);
    });
    archive.pipe(res);

    archive.append(JSON.stringify(result.payload, null, 2), { name: 'data.json' });
    archive.append(EXPORT_README, { name: 'README.md' });

    // Append each on-disk file. safeUploadPath blocks path traversal; a missing
    // file is skipped (the DB row can outlive a file that failed to write).
    for (const file of result.imageFiles) {
      let diskPath;
      try {
        diskPath = safeUploadPath(file.relPath);
      } catch {
        continue;
      }
      if (fs.existsSync(diskPath)) archive.file(diskPath, { name: file.archivePath });
    }

    await archive.finalize();
  } catch (error) {
    console.error('Full export error:', error);
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

// DELETE /api/users/me — schedule account deletion (7-day cooling-off period)
router.delete('/me', requireAuth, async (req, res) => {
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
    // Revoke refresh sessions on the deletion request so a refresh token captured
    // before deletion can't keep minting access tokens through the 7-day window.
    // The user simply re-authenticates to use the account (or to cancel the
    // deletion) — matching change-password / password-reset, which also clear it.
    user.refreshTokenHash = null;
    user.refreshTokenExpiresAt = null;
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
