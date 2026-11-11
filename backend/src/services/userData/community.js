// User-data registry entries: what a member wrote or did among other members.
// The forum, reviews and votes, follows and recommendations, the journal,
// restock alerts and notifications.
// One part of the REGISTRY of services/userDataRegistry.js, which documents the
// entry shape and runs the entries in order.

const User = require('../../models/User');
const Discussion = require('../../models/Discussion');
const ForumLanguage = require('../../models/ForumLanguage');
const DiscussionReply = require('../../models/DiscussionReply');
const DiscussionReaction = require('../../models/DiscussionReaction');
const DiscussionWatch = require('../../models/DiscussionWatch');
const DiscussionRead = require('../../models/DiscussionRead');
const DiscussionReport = require('../../models/DiscussionReport');
const Follow = require('../../models/Follow');
const JournalEntry = require('../../models/JournalEntry');
const Notification = require('../../models/Notification');
const Recommendation = require('../../models/Recommendation');
const RestockAlert = require('../../models/RestockAlert');
const Review = require('../../models/Review');
const ReviewVote = require('../../models/ReviewVote');
const searchService = require('../search');
const { EXPORT_MAX, markTrunc } = require('./shared');

module.exports = [
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
      discussions: markTrunc(ctx, 'discussions', await Discussion.find({ author: ctx.userId }).select('title category language body wineDefinition isPinned isLocked replyCount createdAt updatedAt').limit(EXPORT_MAX).lean())
        .map(d => ({ title: d.title, category: d.category, language: d.language || 'en', body: d.body, wineDefinition: d.wineDefinition, isPinned: d.isPinned, isLocked: d.isLocked, replyCount: d.replyCount, createdAt: d.createdAt, updatedAt: d.updatedAt })),
    }),
  },
  // A member's forum-language requests. The row OUTLIVES the requester (a
  // section other people now post in must not vanish with the person who
  // asked for it), so the pointer is anonymised rather than the row deleted —
  // the same treatment as their forum posts, and the reason it lives in this
  // category rather than 'owned'.
  {
    model: ForumLanguage, category: 'shared-content', userFields: ['requestedBy', 'decidedBy'],
    // Null the pointers rather than re-point them at the [deleted] sentinel:
    // unlike a forum post, nothing renders "requested by X", so the row needs
    // no author at all once the person is gone. A moderator's decidedBy is
    // cleared for the same reason; the audit log keeps the accountable record.
    purge: async (ctx) => Promise.all([
      ForumLanguage.updateMany({ requestedBy: ctx.userId }, { $set: { requestedBy: null, requestReason: null } }),
      ForumLanguage.updateMany({ decidedBy: ctx.userId }, { $set: { decidedBy: null } }),
    ]),
    exportFragment: async (ctx) => ({
      forumLanguageRequests: markTrunc(ctx, 'forumLanguageRequests', await ForumLanguage.find({ requestedBy: ctx.userId })
        .select('code name nativeName status requestReason createdAt decidedAt').limit(EXPORT_MAX).lean()),
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
        // deletedBody: the original text of the user's own soft-deleted
        // replies does not survive their erasure (audit 2026-09 S3-3).
        DiscussionReply.updateMany({ author: ctx.userId }, { $set: { author: ctx.deletedUserId, deletedBody: null } }),
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
    // Review.likesCount is $inc-maintained by the like/unlike route, so a bare
    // deleteMany would leave phantom likes on public reviews forever
    // (grand-audit M11). Reconcile the counter down per affected review BEFORE
    // deleting — same discipline as the Follow entry below. Clamped at 0 so a
    // pre-existing drift can't drive it negative.
    purge: async (ctx) => {
      const votes = await ReviewVote.find({ user: ctx.userId }).select('review').lean();
      const perReview = {};
      for (const v of votes) perReview[v.review] = (perReview[v.review] || 0) + 1;
      const ops = Object.entries(perReview).map(([id, n]) => ({
        updateOne: { filter: { _id: id, likesCount: { $gte: n } }, update: { $inc: { likesCount: -n } } },
      }));
      if (ops.length) await Review.bulkWrite(ops);
      // Any counter that would have gone negative (drift): clamp to 0.
      await Review.updateMany({ _id: { $in: Object.keys(perReview) }, likesCount: { $lt: 0 } }, [{ $set: { likesCount: 0 } }]);
      await ReviewVote.deleteMany({ user: ctx.userId });
    },
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
    model: Recommendation, category: 'personal-data', userFields: ['sender', 'recipient', 'recipientEmail'],
    // Anonymise the departing user's side instead of deleting, so the OTHER
    // party keeps the recommendation: a recipient keeps a from-[deleted] rec,
    // and a sender keeps a to-[deleted] entry in their sent list.
    purge: (ctx) => [
      // Scrub the external recipient's email (third-party PII the departing user
      // supplied) while anonymising the sender side.
      Recommendation.updateMany({ sender: ctx.userId }, { $set: { sender: ctx.deletedUserId }, $unset: { recipientEmail: '' } }),
      Recommendation.updateMany({ recipient: ctx.userId }, { $set: { recipient: ctx.deletedUserId } }),
      // ALSO scrub the departing user's OWN address where it sits as the
      // recipientEmail on OTHER users' sent recs — a recommendation sent to
      // this email before they ever signed up leaves recipient:null, so the
      // two updates above never touch it (grand-audit M10). Match by email.
      ...(ctx.userEmail ? [Recommendation.updateMany({ recipientEmail: ctx.userEmail }, { $unset: { recipientEmail: '' } })] : []),
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
];
