/**
 * User-data registry — the single source of truth for GDPR erasure and export.
 *
 * Every Mongoose model that stores user-linked data has exactly ONE entry here
 * describing how it is (a) purged when an account is deleted and (b) exported
 * for data portability. Both `purgeUserData` and the `/me/export` route are
 * driven off this table, so a model can never be handled on one side and
 * silently forgotten on the other. A regression test
 * (userDataRegistry.test.js) asserts that every model with a `ref: 'User'`
 * field appears here or in EXCLUDED — so adding a new user-linked model fails
 * the build until it is registered.
 *
 * Entry shape:
 *   model        Mongoose model (its .modelName drives the completeness test)
 *   category     personal-data | shared-content | creator-ref | via-cellar
 *   userFields   field paths that link to User (documentation + test reference)
 *   purge(ctx)   returns a Mongoose op promise or array of them (run in the
 *                deletion Promise.all), or null when intentionally not purged
 *   postPurge(ctx)  optional op run AFTER the batch (sees the batch's results)
 *   note         why purge/export is null, when applicable
 *   exportFragment(ctx)  async fn returning a plain object merged (deep) into
 *                the export payload, or null when intentionally not exported
 *
 * ctx = { userId, userEmail, cellarIds, deletedUserId, user, EXPORT_MAX,
 *         AUDIT_MAX, truncated }
 */
const User = require('../models/User');
const AiBudgetRequest = require('../models/AiBudgetRequest');
const ApiToken = require('../models/ApiToken');
const ExportLink = require('../models/ExportLink');
const OAuthAuthCode = require('../models/OAuthAuthCode');
const McpActionLog = require('../models/McpActionLog');
const AiUsage = require('../models/AiUsage');
const Bottle = require('../models/Bottle');
const ClimateDevice = require('../models/ClimateDevice');
const ClimateReading = require('../models/ClimateReading');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const CellarLayout = require('../models/CellarLayout');
const CellarValueSnapshot = require('../models/CellarValueSnapshot');
const ChatUsage = require('../models/ChatUsage');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const DiscussionReaction = require('../models/DiscussionReaction');
const DiscussionWatch = require('../models/DiscussionWatch');
const DiscussionRead = require('../models/DiscussionRead');
const DiscussionReport = require('../models/DiscussionReport');
const Follow = require('../models/Follow');
const ImportSession = require('../models/ImportSession');
const JournalEntry = require('../models/JournalEntry');
const Notification = require('../models/Notification');
const PendingShare = require('../models/PendingShare');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const PriceTrackingRequest = require('../models/PriceTrackingRequest');
const PushSubscription = require('../models/PushSubscription');
const Rack = require('../models/Rack');
const Recommendation = require('../models/Recommendation');
const RestockAlert = require('../models/RestockAlert');
const Review = require('../models/Review');
const ReviewVote = require('../models/ReviewVote');
const SupportTicket = require('../models/SupportTicket');
const WineList = require('../models/WineList');
const WineReport = require('../models/WineReport');
const WineRequest = require('../models/WineRequest');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineVintageProfile = require('../models/WineVintageProfile');
const WishlistItem = require('../models/WishlistItem');
const AuditLog = require('../models/AuditLog');
const BlogPost = require('../models/BlogPost');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const SiteConfig = require('../models/SiteConfig');
const { getOrCreateDeletedUser } = require('../utils/deletedUser');
const { deleteLogoFilesFor } = require('./wineListLogos');
const { unlinkImageFiles } = require('./imageProcessor');
const searchService = require('./search');

const EXPORT_MAX = 50000;
const AUDIT_MAX = 1000;

// Record that an export array hit its cap so the payload's _truncated map flags it.
function markTrunc(ctx, key, arr, cap = EXPORT_MAX) {
  if (arr.length >= cap) ctx.truncated[key] = cap;
  return arr;
}

/**
 * Models with a user reference that are intentionally NOT purged/exported here,
 * with the reason. Keeps the completeness test honest: each is a conscious
 * decision, not an oversight. Items marked "follow-up" are tracked gaps.
 */
const EXCLUDED = {
  // No user reference at all.
  ExchangeRateSnapshot: 'no user reference (daily FX rates)',
  StripeWebhookEvent: 'no user reference (idempotency ledger, TTL)',
  WineEmbedding: 'no user reference (references WineDefinition only)',
  WineNotDuplicate: 'no user reference (admin-confirmed distinct wine pairs; actor in AuditLog)',
  ClimateReading: 'no user reference (telemetry keyed by meta.device; purged + exported via the ClimateDevice entry)',
  OAuthClient: 'no user reference (a DCR-registered connector, not personal data — it is registered pre-login and shared across whoever connects it; the per-user tokens it mints live on ApiToken)',
};

const REGISTRY = [
  // ── The account itself ──────────────────────────────────────────────────
  {
    model: User,
    category: 'personal-data',
    userFields: ['_id', 'discussionBan.bannedBy'],
    // The account row itself is removed by runUserDeletionJob AFTER purgeUserData.
    // Here we only clear this user's admin ref (discussionBan.bannedBy) off OTHER
    // users' records so it doesn't dangle when the issuing admin is deleted.
    purge: (ctx) => User.updateMany({ 'discussionBan.bannedBy': ctx.userId }, { $unset: { 'discussionBan.bannedBy': '' } }),
    note: 'account row deleted by runUserDeletionJob; purge only clears bannedBy on other users',
    exportFragment: async (ctx) => {
      const u = ctx.user;
      return {
        account: {
          username: u.username,
          email: u.email,
          displayName: u.displayName,
          bio: u.bio,
          roles: u.roles,
          plan: u.plan,
          stripeSubscriptionId: u.stripeSubscriptionId || null,
          preferences: u.preferences,
          profileVisibility: u.profileVisibility,
          emailVerified: u.emailVerified,
          gdprConsent: u.gdprConsent,
          createdAt: u.createdAt,
          contribution: u.contribution || { totalScore: 0, categories: {}, tier: 'newcomer', specialty: null },
          // Admin-granted temporary AI budget override (rides on the User doc).
          aiBudgetOverride: u.aiBudgetOverride?.max
            ? { max: u.aiBudgetOverride.max, expiresAt: u.aiBudgetOverride.expiresAt }
            : null,
        },
      };
    },
  },

  // ── Core wine data ──────────────────────────────────────────────────────
  {
    model: Bottle, category: 'personal-data', userFields: ['user'],
    // Collect the ids BEFORE deleteMany so the Meilisearch documents (which
    // carry the user's free-text notes/location) can be removed too — there
    // is no scheduled resync, so skipping this leaves personal data in the
    // search index indefinitely.
    purge: async (ctx) => {
      const bottleIds = await Bottle.find({ user: ctx.userId }).distinct('_id');
      await Bottle.deleteMany({ user: ctx.userId });
      await searchService.removeBottles(bottleIds);
      // The Rack entry below only purges racks in the user's OWN cellars, so a
      // deleted bottle placed in ANOTHER owner's cellar would leave a dangling
      // slot ref in that cellar's racks — pull those slots too.
      await Rack.updateMany(
        { 'slots.bottle': { $in: bottleIds } },
        { $pull: { slots: { bottle: { $in: bottleIds } } } }
      );
    },
    exportFragment: async (ctx) => ({ bottles: markTrunc(ctx, 'bottles', await Bottle.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: BottleImage, category: 'personal-data', userFields: ['uploadedBy', 'reviewedBy'],
    // An image the user promoted to a SHARED wine (assignedToWine) backs the
    // WineDefinition.image that OTHER users see, so it must NOT be deleted on
    // the uploader's account deletion — anonymise it (re-point uploadedBy to the
    // [deleted] sentinel, like forum content) so the shared wine image survives
    // and stays managed. Only the user's own non-shared images are hard-deleted.
    // Also clear this user's reviewedBy ref off OTHER users' images.
    // Unlink the on-disk files (originals + processed PNGs) for the user's own
    // non-shared images BEFORE deleting the docs — those docs are the only
    // reference to the files, so deleting them first would orphan the files on
    // disk forever. Shared (assignedToWine) images are anonymised, not deleted,
    // so their files are kept. Returned as a single self-contained promise so
    // the inner DB ops are awaited (an async fn returning an *array* would not
    // await the queries inside it).
    purge: async (ctx) => {
      const own = await BottleImage.find({ uploadedBy: ctx.userId, assignedToWine: { $ne: true } })
        .select('originalUrl processedUrl').lean();
      for (const img of own) await unlinkImageFiles(img);
      await Promise.all([
        BottleImage.deleteMany({ uploadedBy: ctx.userId, assignedToWine: { $ne: true } }),
        BottleImage.updateMany({ uploadedBy: ctx.userId, assignedToWine: true }, { $set: { uploadedBy: ctx.deletedUserId } }),
        BottleImage.updateMany({ reviewedBy: ctx.userId }, { $unset: { reviewedBy: '' } }),
      ]);
    },
    exportFragment: async (ctx) => ({
      images: markTrunc(ctx, 'images', await BottleImage.find({ uploadedBy: ctx.userId }).limit(EXPORT_MAX).lean())
        .map(i => ({ originalUrl: i.originalUrl, processedUrl: i.processedUrl, uploadedAt: i.createdAt })),
    }),
  },
  {
    model: Cellar, category: 'personal-data', userFields: ['user', 'members.user', 'userColors.user'],
    purge: async (ctx) => {
      // GAP FIX: bottles inside the user's cellars that are OWNED BY OTHERS
      // (legacy data — bottle.user is set to the cellar owner on every current
      // creation path, but older/moved rows can differ) are missed by the
      // user-scoped Bottle purge and would survive pointing at a deleted
      // cellar. Delete them too, cleaning their images + search docs the same
      // reference-safe way as the Bottle/BottleImage entries: ids collected
      // before deleteMany, files unlinked before their only referencing docs
      // go, shared (assignedToWine) images kept with the bottle ref detached.
      const orphanIds = await Bottle.find({ cellar: { $in: ctx.cellarIds }, user: { $ne: ctx.userId } }).distinct('_id');
      if (orphanIds.length > 0) {
        const imgs = await BottleImage.find({ bottle: { $in: orphanIds }, assignedToWine: { $ne: true } })
          .select('originalUrl processedUrl').lean();
        for (const img of imgs) await unlinkImageFiles(img);
        await Promise.all([
          BottleImage.deleteMany({ bottle: { $in: orphanIds }, assignedToWine: { $ne: true } }),
          BottleImage.updateMany({ bottle: { $in: orphanIds }, assignedToWine: true }, { $unset: { bottle: '' } }),
          Bottle.deleteMany({ _id: { $in: orphanIds } }),
        ]);
        await searchService.removeBottles(orphanIds);
      }
      await Promise.all([
        Cellar.deleteMany({ user: ctx.userId }),
        // Remove the user from cellars OWNED BY OTHERS that they were a member of.
        Cellar.updateMany({ 'members.user': ctx.userId }, { $pull: { members: { user: ctx.userId } } }),
        // GAP FIX: also pull the matching userColors entry (was left dangling).
        Cellar.updateMany({ 'userColors.user': ctx.userId }, { $pull: { userColors: { user: ctx.userId } } }),
      ]);
    },
    exportFragment: async (ctx) => ({
      cellars: markTrunc(ctx, 'cellars', await Cellar.find({ $or: [{ user: ctx.userId }, { 'members.user': ctx.userId }], deletedAt: null }).limit(EXPORT_MAX).lean()),
    }),
  },
  {
    model: Rack, category: 'personal-data', userFields: ['user'],
    // Scoped to the user's OWNED cellars. A rack this user created inside
    // ANOTHER owner's cellar is deliberately NOT deleted here — it belongs to
    // that cellar and deleting it would damage another user's data (treated as
    // a contributor ref, follow-up).
    purge: (ctx) => Rack.deleteMany({ cellar: { $in: ctx.cellarIds } }),
    exportFragment: async (ctx) => ({ racks: markTrunc(ctx, 'racks', await Rack.find({ cellar: { $in: ctx.cellarIds }, deletedAt: null }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: CellarLayout, category: 'via-cellar', userFields: ['(via cellar)'],
    purge: (ctx) => CellarLayout.deleteMany({ cellar: { $in: ctx.cellarIds } }),
    // GAP FIX: was purged but never exported.
    exportFragment: async (ctx) => ({ cellarLayouts: markTrunc(ctx, 'cellarLayouts', await CellarLayout.find({ cellar: { $in: ctx.cellarIds } }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: WineList, category: 'personal-data', userFields: ['user'],
    // Uploaded restaurant logos are user content too — unlink them from disk
    // before the docs (and with them the only references) are deleted.
    purge: async (ctx) => {
      await deleteLogoFilesFor(WineList, { user: ctx.userId });
      return WineList.deleteMany({ user: ctx.userId });
    },
    exportFragment: async (ctx) => ({
      wineLists: markTrunc(ctx, 'wineLists', await WineList.find({ user: ctx.userId }).select('name cellar structureMode branding layout createdAt updatedAt').limit(EXPORT_MAX).lean())
        .map(wl => ({ name: wl.name, structureMode: wl.structureMode, branding: wl.branding, layout: wl.layout, createdAt: wl.createdAt })),
    }),
  },
  {
    model: WishlistItem, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => WishlistItem.deleteMany({ user: ctx.userId }),
    // Trunc flag key kept as 'wishlistItems' to match the pre-refactor _truncated payload.
    exportFragment: async (ctx) => ({ wishlist: markTrunc(ctx, 'wishlistItems', await WishlistItem.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },

  // ── Forum content: anonymise (preserve multi-party threads) ─────────────
  {
    model: Discussion, category: 'shared-content', userFields: ['author'],
    // Re-index after anonymisation — the Meilisearch discussions index
    // denormalises authorName, which would otherwise keep the deleted
    // user's name until some unrelated event re-indexed the thread.
    purge: async (ctx) => {
      const discussionIds = await Discussion.find({ author: ctx.userId }).distinct('_id');
      await Discussion.updateMany({ author: ctx.userId }, { $set: { author: ctx.deletedUserId } });
      for (const id of discussionIds) await searchService.indexDiscussion(id);
    },
    exportFragment: async (ctx) => ({
      discussions: markTrunc(ctx, 'discussions', await Discussion.find({ author: ctx.userId }).select('title category body wineDefinition isPinned isLocked replyCount createdAt updatedAt').limit(EXPORT_MAX).lean())
        .map(d => ({ title: d.title, category: d.category, body: d.body, wineDefinition: d.wineDefinition, isPinned: d.isPinned, isLocked: d.isLocked, replyCount: d.replyCount, createdAt: d.createdAt, updatedAt: d.updatedAt })),
    }),
  },
  {
    model: DiscussionReply, category: 'shared-content', userFields: ['author', 'quote.authorId'],
    // Besides re-pointing the user's own replies to the [deleted] sentinel,
    // scrub the user's display name from quote snapshots on OTHER users'
    // replies (L-17): quote.authorName is a denormalised string set at
    // reply-creation that any anonymous visitor can read. Rows are matched by
    // quote.authorId; legacy rows created before authorId existed are resolved
    // through quote.replyId → the user's own reply ids (collected BEFORE the
    // author re-point runs). Residue: a legacy quote whose quoted reply was
    // since hard-deleted cannot be attributed and keeps its name snapshot.
    purge: async (ctx) => {
      const ownReplyIds = await DiscussionReply.distinct('_id', { author: ctx.userId });
      await Promise.all([
        DiscussionReply.updateMany({ author: ctx.userId }, { $set: { author: ctx.deletedUserId } }),
        DiscussionReply.updateMany(
          { 'quote.authorId': ctx.userId },
          { $set: { 'quote.authorName': '[deleted]', 'quote.authorId': ctx.deletedUserId } }
        ),
        DiscussionReply.updateMany(
          { 'quote.authorId': null, 'quote.replyId': { $in: ownReplyIds } },
          { $set: { 'quote.authorName': '[deleted]' } }
        ),
      ]);
    },
    exportFragment: async (ctx) => ({
      discussionReplies: markTrunc(ctx, 'discussionReplies', await DiscussionReply.find({ author: ctx.userId }).select('discussion body quote wineDefinition isDeleted createdAt updatedAt').limit(EXPORT_MAX).lean())
        .map(r => ({ discussion: r.discussion, body: r.body, quote: r.quote, wineDefinition: r.wineDefinition, isDeleted: r.isDeleted, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    }),
  },
  // Personal-data-only forum collections: hard-delete.
  {
    model: DiscussionReaction, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => DiscussionReaction.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      discussionReactions: markTrunc(ctx, 'discussionReactions', await DiscussionReaction.find({ user: ctx.userId }).select('reply kind createdAt').limit(EXPORT_MAX).lean())
        .map(r => ({ reply: r.reply, kind: r.kind, createdAt: r.createdAt })),
    }),
  },
  {
    model: DiscussionWatch, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => DiscussionWatch.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      discussionWatches: markTrunc(ctx, 'discussionWatches', await DiscussionWatch.find({ user: ctx.userId }).select('discussion createdAt').limit(EXPORT_MAX).lean())
        .map(w => ({ discussion: w.discussion, createdAt: w.createdAt })),
    }),
  },
  {
    model: DiscussionRead, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => DiscussionRead.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      discussionReads: markTrunc(ctx, 'discussionReads', await DiscussionRead.find({ user: ctx.userId }).select('discussion lastReadAt').limit(EXPORT_MAX).lean())
        .map(r => ({ discussion: r.discussion, lastReadAt: r.lastReadAt })),
    }),
  },
  {
    model: DiscussionReport, category: 'personal-data', userFields: ['user', 'resolvedBy'],
    purge: (ctx) => [
      DiscussionReport.deleteMany({ user: ctx.userId }),
      // Clear this user's moderator ref off OTHER users' reports.
      DiscussionReport.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      reports: { discussions: markTrunc(ctx, 'discussionReports', await DiscussionReport.find({ user: ctx.userId }).select('discussion reply reason createdAt').limit(EXPORT_MAX).lean())
        .map(r => ({ reason: r.reason, createdAt: r.createdAt })) },
    }),
  },

  // ── Reviews & votes ─────────────────────────────────────────────────────
  {
    model: Review, category: 'shared-content', userFields: ['author'],
    // Anonymised (re-pointed to the [deleted] sentinel) like forum content, so
    // the public review + rating and other users' votes on it survive erasure.
    // (Indexes on author are non-unique, so collapsing to one sentinel is safe.)
    purge: (ctx) => Review.updateMany({ author: ctx.userId }, { $set: { author: ctx.deletedUserId } }),
    exportFragment: async (ctx) => ({ reviews: markTrunc(ctx, 'reviews', await Review.find({ author: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: ReviewVote, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => ReviewVote.deleteMany({ user: ctx.userId }),
    // BUG FIX: schema has no `vote` field (only user/review/createdAt); the old
    // export emitted vote:undefined. Export the real fields.
    exportFragment: async (ctx) => ({
      reviewVotes: markTrunc(ctx, 'reviewVotes', await ReviewVote.find({ user: ctx.userId }).select('review createdAt').limit(EXPORT_MAX).lean())
        .map(v => ({ review: v.review, createdAt: v.createdAt })),
    }),
  },

  // ── Social ──────────────────────────────────────────────────────────────
  {
    model: Follow, category: 'personal-data', userFields: ['follower', 'following'],
    purge: async (ctx) => {
      // Reconcile the denormalized counters on the counterparties BEFORE removing
      // the edges — otherwise deleting a user leaves everyone they were connected
      // to with a permanently inflated followersCount / followingCount (the live
      // follow/unfollow paths keep these in sync, but the hard-delete skipped it).
      const edges = await Follow.find({ $or: [{ follower: ctx.userId }, { following: ctx.userId }] })
        .select('follower following').lean();
      const decFollowers = {}; // people this user followed → their followersCount drops
      const decFollowing = {}; // people who followed this user → their followingCount drops
      for (const e of edges) {
        if (String(e.follower) === String(ctx.userId)) decFollowers[e.following] = (decFollowers[e.following] || 0) + 1;
        if (String(e.following) === String(ctx.userId)) decFollowing[e.follower] = (decFollowing[e.follower] || 0) + 1;
      }
      const ops = [
        ...Object.entries(decFollowers).map(([id, n]) => ({
          updateOne: { filter: { _id: id }, update: { $inc: { followersCount: -n } } },
        })),
        ...Object.entries(decFollowing).map(([id, n]) => ({
          updateOne: { filter: { _id: id }, update: { $inc: { followingCount: -n } } },
        })),
      ];
      if (ops.length) await User.bulkWrite(ops);
      // Clamp any counter that may have drifted negative.
      await User.updateMany({ followersCount: { $lt: 0 } }, [{ $set: { followersCount: 0 } }]);
      await User.updateMany({ followingCount: { $lt: 0 } }, [{ $set: { followingCount: 0 } }]);
      return Follow.deleteMany({ $or: [{ follower: ctx.userId }, { following: ctx.userId }] });
    },
    exportFragment: async (ctx) => {
      const follows = await Follow.find({ $or: [{ follower: ctx.userId }, { following: ctx.userId }] }).limit(EXPORT_MAX)
        .populate('follower', 'username').populate('following', 'username').lean();
      markTrunc(ctx, 'follows', follows);
      const id = ctx.userId;
      return {
        social: {
          following: follows.filter(f => f.follower?._id?.toString() === id || f.follower?.toString() === id)
            .map(f => ({ username: f.following?.username, createdAt: f.createdAt })),
          followers: follows.filter(f => f.following?._id?.toString() === id || f.following?.toString() === id)
            .map(f => ({ username: f.follower?.username, createdAt: f.createdAt })),
        },
      };
    },
  },
  {
    model: Recommendation, category: 'personal-data', userFields: ['sender', 'recipient'],
    // Anonymise the departing user's side instead of deleting, so the OTHER
    // party keeps the recommendation: a recipient keeps a from-[deleted] rec,
    // and a sender keeps a to-[deleted] entry in their sent list.
    purge: (ctx) => [
      // Scrub the external recipient's email (third-party PII the departing user
      // supplied) while anonymising the sender side.
      Recommendation.updateMany({ sender: ctx.userId }, { $set: { sender: ctx.deletedUserId }, $unset: { recipientEmail: '' } }),
      Recommendation.updateMany({ recipient: ctx.userId }, { $set: { recipient: ctx.deletedUserId } }),
    ],
    exportFragment: async (ctx) => {
      const [sent, received] = await Promise.all([
        Recommendation.find({ sender: ctx.userId }).limit(EXPORT_MAX).populate('wine', 'name producer').lean(),
        Recommendation.find({ recipient: ctx.userId }).limit(EXPORT_MAX).populate('wine', 'name producer').populate('sender', 'username').lean(),
      ]);
      markTrunc(ctx, 'recommendationsSent', sent);
      markTrunc(ctx, 'recommendationsReceived', received);
      return {
        recommendations: {
          sent: sent.map(r => ({ wine: r.wine?.name, producer: r.wine?.producer, recipientEmail: r.recipientEmail, note: r.note, status: r.status, createdAt: r.createdAt })),
          received: received.map(r => ({ wine: r.wine?.name, producer: r.wine?.producer, from: r.sender?.username, note: r.note, status: r.status, createdAt: r.createdAt })),
        },
      };
    },
  },

  // ── Journal & alerts ────────────────────────────────────────────────────
  {
    model: JournalEntry, category: 'personal-data', userFields: ['user', 'people.user'],
    // people[].user tags on OTHER users' entries are a contributor-ref follow-up
    // (the safe fix unsets just the ref while keeping the host user's typed name).
    purge: (ctx) => JournalEntry.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      journal: markTrunc(ctx, 'journalEntries', await JournalEntry.find({ user: ctx.userId }).limit(EXPORT_MAX).lean())
        .map(j => ({ date: j.date, title: j.title, occasion: j.occasion, people: j.people?.map(p => p.name),
          pairings: j.pairings?.map(p => ({ dish: p.dish, wineName: p.wineName, notes: p.notes })),
          mood: j.mood, notes: j.notes, visibility: j.visibility, createdAt: j.createdAt })),
    }),
  },
  {
    model: RestockAlert, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => RestockAlert.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      restockAlerts: markTrunc(ctx, 'restockAlerts', await RestockAlert.find({ user: ctx.userId }).limit(EXPORT_MAX).lean())
        .map(a => ({ wineName: a.wineName, wineProducer: a.wineProducer, status: a.status, createdAt: a.createdAt })),
    }),
  },
  {
    model: Notification, category: 'personal-data', userFields: ['user', 'actor'],
    // Delete both the departing user's OWN notifications AND notifications
    // delivered to OTHERS that this user triggered (follow/reply/mention/
    // recommendation) — those denormalize the departing user's display name into
    // the title/message, so leaving them would let a deleted user's name persist
    // in third parties' feeds until the 90-day TTL. `actor` (set at creation)
    // makes them matchable.
    purge: (ctx) => Notification.deleteMany({ $or: [{ user: ctx.userId }, { actor: ctx.userId }] }),
    exportFragment: async (ctx) => ({
      notifications: markTrunc(ctx, 'notifications', await Notification.find({ user: ctx.userId }).limit(EXPORT_MAX).lean())
        .map(n => ({ ...n, _id: undefined })),
    }),
  },

  // ── Requests & reports ──────────────────────────────────────────────────
  {
    model: WineRequest, category: 'shared-content', userFields: ['user', 'resolvedBy'],
    purge: (ctx) => [
      WineRequest.deleteMany({ user: ctx.userId }),
      WineRequest.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({ wineRequests: markTrunc(ctx, 'wineRequests', await WineRequest.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: WineReport, category: 'shared-content', userFields: ['user', 'resolvedBy'],
    purge: (ctx) => [
      WineReport.deleteMany({ user: ctx.userId }),
      WineReport.updateMany({ resolvedBy: ctx.userId }, { $unset: { resolvedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      reports: { wines: markTrunc(ctx, 'wineReports', await WineReport.find({ user: ctx.userId }).select('wineDefinition reason status createdAt').limit(EXPORT_MAX).lean())
        .map(r => ({ reason: r.reason, status: r.status, createdAt: r.createdAt })) },
    }),
  },
  {
    model: SupportTicket, category: 'personal-data', userFields: ['user', 'respondedBy'],
    purge: (ctx) => [
      SupportTicket.deleteMany({ user: ctx.userId }),
      // Clear this user's staff ref off OTHER users' tickets.
      SupportTicket.updateMany({ respondedBy: ctx.userId }, { $unset: { respondedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      supportTickets: markTrunc(ctx, 'supportTickets', await SupportTicket.find({ user: ctx.userId }).select('category subject message status adminResponse respondedAt createdAt').limit(EXPORT_MAX).lean())
        .map(t => ({ category: t.category, subject: t.subject, message: t.message, status: t.status, adminResponse: t.adminResponse, respondedAt: t.respondedAt, createdAt: t.createdAt })),
    }),
  },

  // ── API tokens ──────────────────────────────────────────────────────────
  {
    model: ApiToken, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure — a token row is pure credential bookkeeping.
    purge: (ctx) => ApiToken.deleteMany({ user: ctx.userId }),
    // Export metadata only. The tokenHash / refreshTokenHash NEVER leave the
    // database — they are not the user's data, they are the credential itself.
    // `origin` distinguishes user-minted PATs from OAuth AI connections.
    exportFragment: async (ctx) => ({
      apiTokens: markTrunc(ctx, 'apiTokens', await ApiToken.find({ user: ctx.userId })
        .select('name scopes origin lastUsedAt createdAt revokedAt').limit(EXPORT_MAX).lean())
        .map(t => ({ name: t.name, scopes: t.scopes, origin: t.origin || 'personal', lastUsedAt: t.lastUsedAt, createdAt: t.createdAt, revokedAt: t.revokedAt })),
    }),
  },

  // ── Export download links ──────────────────────────────────────────────
  {
    model: ExportLink, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure. An ExportLink is a throwaway one-hour download
    // credential, not user data — the exportable data it points AT is exported
    // through its own registry entries (cellars, account, …). Nothing to export
    // here (and the tokenHash, like ApiToken's, never leaves the DB).
    purge: (ctx) => ExportLink.deleteMany({ user: ctx.userId }),
    exportFragment: null,
  },

  // ── OAuth authorization codes ─────────────────────────────────────────────
  {
    model: OAuthAuthCode, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure. These are single-use, 5-minute credentials that
    // TTL themselves away; nothing to export (an ephemeral, spent-or-expired
    // authorization code is not meaningful personal data). The tokens they mint
    // are covered by the ApiToken entry above.
    purge: (ctx) => OAuthAuthCode.deleteMany({ user: ctx.userId }),
    exportFragment: null,
  },

  // ── MCP action ledger ───────────────────────────────────────────────────
  {
    model: McpActionLog, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure — operational undo/idempotency bookkeeping.
    purge: (ctx) => McpActionLog.deleteMany({ user: ctx.userId }),
    // Export what the connected AI changed (right of access) INCLUDING prev —
    // after a restore, the user's consumed note/rating snapshot may exist only
    // here for up to the TTL. Never the idempotency keys or stored result
    // payloads (operational plumbing).
    exportFragment: async (ctx) => ({
      mcpActions: markTrunc(ctx, 'mcpActions', await McpActionLog.find({ user: ctx.userId })
        .select('tool action bottle cellar detail prev reversed createdAt').limit(EXPORT_MAX).lean())
        .map(a => ({ tool: a.tool, action: a.action, bottle: a.bottle, cellar: a.cellar, detail: a.detail, prev: a.prev || null, reversed: a.reversed, createdAt: a.createdAt })),
    }),
  },

  // ── Climate monitoring ──────────────────────────────────────────────────
  {
    model: ClimateDevice, category: 'personal-data', userFields: ['user'],
    // ClimateReading rows are keyed by device (meta.device, no user ref) — they
    // are purged and exported HERE, through the device→user link, which is why
    // ClimateReading itself sits in EXCLUDED. Ids are collected before the
    // device deleteMany so the readings can still be found. The devices' API
    // tokens are hard-deleted by the ApiToken entry above.
    purge: async (ctx) => {
      const deviceIds = await ClimateDevice.find({ user: ctx.userId }).distinct('_id');
      if (deviceIds.length > 0) {
        await ClimateReading.deleteMany({ 'meta.device': { $in: deviceIds } });
      }
      await ClimateDevice.deleteMany({ user: ctx.userId });
    },
    exportFragment: async (ctx) => {
      const devices = await ClimateDevice.find({ user: ctx.userId }).limit(EXPORT_MAX).lean();
      const deviceIds = devices.map(d => d._id);
      const readings = deviceIds.length > 0
        ? await ClimateReading.find({ 'meta.device': { $in: deviceIds } })
          .sort({ ts: -1 }).limit(EXPORT_MAX).lean()
        : [];
      return {
        climateDevices: markTrunc(ctx, 'climateDevices', devices).map(d => ({
          name: d.name,
          cellar: d.cellar,
          firmware: d.firmware,
          lastSeenAt: d.lastSeenAt,
          lastRssi: d.lastRssi,
          createdAt: d.createdAt,
          channels: (d.channels || []).map(c => ({ key: c.key, type: c.type, label: c.label, calibrationOffset: c.calibrationOffset })),
        })),
        climateReadings: markTrunc(ctx, 'climateReadings', readings)
          .map(r => ({ ts: r.ts, device: r.meta?.device, channel: r.meta?.channel, type: r.meta?.type, value: r.value })),
      };
    },
  },

  // ── Import & usage ──────────────────────────────────────────────────────
  {
    model: ImportSession, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => ImportSession.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      importSessions: markTrunc(ctx, 'importSessions', await ImportSession.find({ user: ctx.userId }).select('cellar status results positionAnchor rackConfigs defaultCurrency createdAt').limit(EXPORT_MAX).lean())
        .map(s => ({ cellar: s.cellar, status: s.status, rowCount: s.results?.length || 0, positionAnchor: s.positionAnchor, rackConfigs: s.rackConfigs, defaultCurrency: s.defaultCurrency, createdAt: s.createdAt })),
    }),
  },
  {
    model: AiBudgetRequest, category: 'personal-data', userFields: ['user', 'decidedBy'],
    purge: (ctx) => [
      AiBudgetRequest.deleteMany({ user: ctx.userId }),
      // Clear this user's admin ref off OTHER users' decided requests.
      AiBudgetRequest.updateMany({ decidedBy: ctx.userId }, { $unset: { decidedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      aiBudgetRequests: markTrunc(ctx, 'aiBudgetRequests',
        await AiBudgetRequest.find({ user: ctx.userId })
          .select('reason requestedContext status grantedMax grantedUntil createdAt decidedAt')
          .limit(EXPORT_MAX).lean())
        .map(r => ({
          reason: r.reason,
          pendingRows: r.requestedContext?.pendingRows ?? null,
          status: r.status,
          grantedMax: r.grantedMax,
          grantedUntil: r.grantedUntil,
          createdAt: r.createdAt,
          decidedAt: r.decidedAt,
        })),
    }),
  },
  {
    // Same handling as ChatUsage: per-user daily AI-call counters (90-day
    // TTL). The site-wide kill-switch row has userId: null and is not
    // personal data — untouched by the per-user purge, as intended.
    model: AiUsage, category: 'personal-data', userFields: ['userId'],
    purge: (ctx) => AiUsage.deleteMany({ userId: ctx.userId }),
    exportFragment: async (ctx) => ({
      aiUsage: markTrunc(ctx, 'aiUsage', await AiUsage.find({ userId: ctx.userId }).select('date count').limit(EXPORT_MAX).lean())
        .map(u => ({ date: u.date, count: u.count })),
    }),
  },
  {
    model: ChatUsage, category: 'personal-data', userFields: ['userId'],
    purge: (ctx) => ChatUsage.deleteMany({ userId: ctx.userId }),
    // BUG FIX: schema fields are count/inputTokens/outputTokens — the old export
    // selected promptTokens/completionTokens which don't exist (always undefined).
    exportFragment: async (ctx) => ({
      chatUsage: markTrunc(ctx, 'chatUsage', await ChatUsage.find({ userId: ctx.userId }).select('date count inputTokens outputTokens').limit(EXPORT_MAX).lean())
        .map(c => ({ date: c.date, count: c.count, inputTokens: c.inputTokens, outputTokens: c.outputTokens })),
    }),
  },
  {
    model: PushSubscription, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => PushSubscription.deleteMany({ user: ctx.userId }),
    // Not exported: the subscription is device push-crypto (endpoint + p256dh/
    // auth secrets), not useful or safe portability data. Tracked as a follow-up
    // if a minimal (endpoint-only) export is ever wanted.
    exportFragment: null,
    note: 'push crypto secrets — minimal export is a follow-up decision',
  },
  {
    model: CellarValueSnapshot, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => CellarValueSnapshot.deleteMany({ user: ctx.userId }),
    // GAP FIX: was purged but never exported.
    exportFragment: async (ctx) => ({
      cellarValueSnapshots: markTrunc(ctx, 'cellarValueSnapshots', await CellarValueSnapshot.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()),
    }),
  },

  // ── Price tracking ──────────────────────────────────────────────────────
  {
    model: PriceTrackingSkip, category: 'personal-data', userFields: ['skippedBy'],
    purge: (ctx) => PriceTrackingSkip.deleteMany({ skippedBy: ctx.userId }),
    exportFragment: async (ctx) => ({
      priceTracking: { skips: markTrunc(ctx, 'priceTrackingSkips', await PriceTrackingSkip.find({ skippedBy: ctx.userId }).select('wineDefinition vintage reason skippedAt').limit(EXPORT_MAX).lean())
        .map(s => ({ wineDefinition: s.wineDefinition, vintage: s.vintage, reason: s.reason, skippedAt: s.skippedAt })) },
    }),
  },
  {
    model: PriceTrackingRequest, category: 'shared-content', userFields: ['requesters.user'],
    purge: (ctx) => PriceTrackingRequest.updateMany({ 'requesters.user': ctx.userId }, { $pull: { requesters: { user: ctx.userId } } }),
    // After the pull, a doc with no requesters left is an orphan.
    postPurge: () => PriceTrackingRequest.deleteMany({ requesters: { $size: 0 } }),
    exportFragment: async (ctx) => {
      const reqs = markTrunc(ctx, 'priceTrackingRequests', await PriceTrackingRequest.find({ 'requesters.user': ctx.userId }).select('wineDefinition vintage requesters createdAt').limit(EXPORT_MAX).lean());
      return {
        priceTracking: { requests: reqs.map(pt => {
          const mine = (pt.requesters || []).find(r => (r.user?.toString?.() || r.user) === ctx.userId);
          return { wineDefinition: pt.wineDefinition, vintage: pt.vintage, note: mine?.note, requestedAt: mine?.requestedAt };
        }) },
      };
    },
  },

  // ── Invites ─────────────────────────────────────────────────────────────
  {
    model: PendingShare, category: 'personal-data', userFields: ['invitedBy', 'email'],
    purge: (ctx) => PendingShare.deleteMany({ $or: [{ invitedBy: ctx.userId }, { email: ctx.userEmail }] }),
    exportFragment: async (ctx) => {
      const [sent, received] = await Promise.all([
        PendingShare.find({ invitedBy: ctx.userId }).limit(EXPORT_MAX).populate('cellar', 'name').lean(),
        // GAP FIX: invites RECEIVED at the user's email were deleted but never
        // exported. Guard against a missing email — find({ email: undefined })
        // matches the WHOLE collection and would leak other users' invites.
        ctx.userEmail
          ? PendingShare.find({ email: ctx.userEmail }).limit(EXPORT_MAX).populate('cellar', 'name').lean()
          : [],
      ]);
      markTrunc(ctx, 'pendingSharesSent', sent);
      return {
        pendingCellarInvites: sent.map(ps => ({ invitedEmail: ps.email, cellarName: ps.cellar?.name, role: ps.role, createdAt: ps.createdAt })),
        pendingCellarInvitesReceived: received.map(ps => ({ cellarName: ps.cellar?.name, role: ps.role, createdAt: ps.createdAt })),
      };
    },
  },

  // ── Somm-contributed data: clear the user ref, keep the shared data ──────
  {
    model: WineVintagePrice, category: 'creator-ref', userFields: ['setBy'],
    purge: (ctx) => WineVintagePrice.updateMany({ setBy: ctx.userId }, { $unset: { setBy: '', sommNotes: '' } }),
    exportFragment: null,
    note: 'somm price contribution (shared data); portability of own contributions is a follow-up',
  },
  {
    model: WineVintageProfile, category: 'creator-ref', userFields: ['setBy'],
    // BUG FIX: also clear sommNotes (the old code unset setBy+setAt but left the
    // somm's authored notes on the now-anonymised profile, unlike WineVintagePrice).
    purge: (ctx) => WineVintageProfile.updateMany({ setBy: ctx.userId }, { $unset: { setBy: '', setAt: '', sommNotes: '' } }),
    exportFragment: null,
    note: 'somm maturity contribution (shared data); portability of own contributions is a follow-up',
  },

  // ── Blog ────────────────────────────────────────────────────────────────
  {
    model: BlogPost, category: 'shared-content', userFields: ['author'],
    purge: (ctx) => BlogPost.updateMany({ author: ctx.userId }, { $unset: { author: '' } }),
    exportFragment: null,
    note: 'authored public content (preserved, author unset on delete); portability is a follow-up',
  },

  // ── Shared taxonomy / registry: reassign the contributor ref ────────────
  // These documents are admin-managed shared data that survives the user's
  // deletion. They carry only a creator/editor ref to the departing user; we
  // re-point it to the [deleted] sentinel so the ref doesn't dangle (createdBy
  // is `required`, so it can't be unset). Not exported — not the user's data.
  {
    model: WineDefinition, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => WineDefinition.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared registry; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Country, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Country.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Region, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Region.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Grape, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Grape.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Appellation, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Appellation.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: SiteConfig, category: 'creator-ref', userFields: ['updatedBy'],
    // updatedBy is nullable — clear it (don't reassign).
    purge: (ctx) => SiteConfig.updateMany({ updatedBy: ctx.userId }, { $unset: { updatedBy: '' } }),
    exportFragment: null,
    note: 'global config; nullable updatedBy cleared on erasure',
  },

  // ── Audit log: keep for compliance, anonymise the actor ─────────────────
  {
    model: AuditLog, category: 'personal-data', userFields: ['actor.userId'],
    // Also scrub identifier PII the free-form detail can carry — registration/
    // login events embed { username, email }, and cellar-sharing events embed
    // the invitee's address as { sharedWith } / { invitedEmail } (L-15). $unset
    // only touches docs that actually have those keys, so it's safe across the
    // heterogeneous detail shapes.
    purge: (ctx) => [
      // (a) The departing user as the ACTOR of their own events.
      AuditLog.updateMany(
        { 'actor.userId': ctx.userId },
        {
          $set: { 'actor.userId': null, 'actor.ipAddress': null },
          $unset: { 'detail.email': '', 'detail.username': '', 'detail.sharedWith': '', 'detail.invitedEmail': '' },
        }
      ),
      // (b) The departing user as the SUBJECT of ANOTHER actor's event — a
      // cellar-share event stores the invitee's email in the INVITER's row
      // (detail.sharedWith / detail.invitedEmail). The actor-scoped scrub above
      // never touches those, so match on the departing user's email instead.
      ...(ctx.userEmail ? [AuditLog.updateMany(
        { $or: [{ 'detail.sharedWith': ctx.userEmail }, { 'detail.invitedEmail': ctx.userEmail }] },
        { $unset: { 'detail.sharedWith': '', 'detail.invitedEmail': '' } }
      )] : []),
    ],
    exportFragment: async (ctx) => ({
      activityLog: markTrunc(ctx, 'activityLog', await AuditLog.find({ 'actor.userId': ctx.userId }).sort({ timestamp: -1 }).limit(AUDIT_MAX).lean(), AUDIT_MAX)
        .map(a => ({ action: a.action, timestamp: a.timestamp, detail: a.detail })),
    }),
  },
];

// ── Executors ───────────────────────────────────────────────────────────────

/** Deep-merge plain-object export fragments (so e.g. priceTracking.requests and
 *  priceTracking.skips from two entries combine instead of overwriting). */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    // Guard against prototype pollution. Fragment keys are hardcoded in this
    // file (not user input), so this is defence-in-depth — but it keeps the
    // helper safe for any future caller and satisfies static analysis.
    if (PROTO_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Permanently erase all data linked to a user. Runs every registry entry's
 * purge op in one Promise.all, then the post-batch cleanups.
 */
async function purgeUserData(userId, userEmail) {
  const cellarIds = await Cellar.distinct('_id', { user: userId });
  const deletedUserId = await getOrCreateDeletedUser();
  const ctx = { userId, userEmail, cellarIds, deletedUserId };

  const ops = [];
  for (const entry of REGISTRY) {
    if (!entry.purge) continue;
    const result = entry.purge(ctx);
    if (Array.isArray(result)) ops.push(...result);
    else ops.push(result);
  }
  await Promise.all(ops);

  for (const entry of REGISTRY) {
    if (entry.postPurge) await entry.postPurge(ctx);
  }
}

/**
 * Build the GDPR data-portability export payload for a user. Runs every
 * registry entry's export fragment and deep-merges them, then stamps the
 * truncation map.
 */
async function buildUserExport(userId, user) {
  const cellarIds = await Cellar.distinct('_id', { user: userId });
  const ctx = { userId, userEmail: user.email, user, cellarIds, EXPORT_MAX, AUDIT_MAX, truncated: {} };

  const exportData = { exportedAt: new Date().toISOString() };
  const fragments = await Promise.all(
    REGISTRY.filter(e => e.exportFragment).map(e => e.exportFragment(ctx))
  );
  for (const frag of fragments) deepMerge(exportData, frag);

  if (Object.keys(ctx.truncated).length > 0) {
    console.warn('[userDataExport] truncation hit for user', userId, ctx.truncated);
    exportData._truncated = ctx.truncated;
  }
  return exportData;
}

/** Model names with a purge and/or export handler — used by the completeness test. */
function registeredModelNames() {
  return REGISTRY.map(e => e.model.modelName);
}

module.exports = {
  REGISTRY,
  EXCLUDED,
  purgeUserData,
  buildUserExport,
  registeredModelNames,
  EXPORT_MAX,
};
