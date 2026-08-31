const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireNonDemo, optionalAuth, requireModeratorOrAdmin, isModerator } = require('../middleware/auth');
const Discussion = require('../models/Discussion');
const { CATEGORIES } = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const DiscussionReaction = require('../models/DiscussionReaction');
const { REACTION_KINDS } = require('../models/DiscussionReaction');
const DiscussionWatch = require('../models/DiscussionWatch');
const DiscussionRead = require('../models/DiscussionRead');
const DiscussionReport = require('../models/DiscussionReport');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const BlogPost = require('../models/BlogPost');
const { stripHtml, escapeRegex } = require('../utils/sanitize');
const { sanitizeForumHtml, visibleTextLength } = require('../utils/sanitizeHtml');
const { logAudit } = require('../services/audit');
const { incrementCred, decrementCred } = require('../utils/cellarCred');
const {
  resolveReadableLanguage, resolveWritableLanguage, resolveMoveTarget, DEFAULT_LANGUAGE,
} = require('../services/forumLanguages');
const { submitUrls: submitToIndexNow } = require('../services/indexNow');
const { createNotification, createNotifications } = require('../services/notifications');
const { extractMentions } = require('../utils/mentionParser');
const searchService = require('../services/search');
const { sendDiscussionReplyEmail, EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');
const { parsePagination } = require('../utils/pagination');
const { isValidId, coerceStringQuery } = require('../utils/validation');
const { DISCUSSIONS_PER_PAGE, DISCUSSIONS_MAX_PER_PAGE, DISCUSSION_MAX_LENGTHS } = require('../config/constants');

const router = express.Router();

// Per-route auth: GETs use optionalAuth (public reads with personalization when
// logged in), writes use requireAuth. Moderation routes additionally require
// requireModeratorOrAdmin. There is no global requireAuth on the router.

// Resolve a URL parameter that may be either an ObjectId or a slug to a Discussion
// document. The slug form is the canonical SEO URL, so writes triggered from a
// thread that the user navigated to via slug must still find the discussion.
async function findDiscussionByIdOrSlug(idOrSlug) {
  if (!idOrSlug) return null;
  const filter = isValidId(idOrSlug)
    ? { _id: idOrSlug }
    : { slug: String(idOrSlug).toLowerCase() };
  return Discussion.findOne(filter);
}

// Check if the requesting user is banned from discussions; returns error response or null
async function checkDiscussionBan(req, res) {
  const u = await User.findById(req.user.id).select('discussionBan');
  if (u && u.isDiscussionBanned()) {
    const ban = u.discussionBan;
    const msg = ban.expiresAt
      ? `You are banned from discussions until ${ban.expiresAt.toISOString()}`
      : 'You are permanently banned from discussions';
    res.status(403).json({ error: msg, banned: true, expiresAt: ban.expiresAt });
    return true;
  }
  return false;
}

// GET /api/discussions - List discussions (public)
//
// When `q` is provided we route through Meilisearch for fuzzy text matching;
// otherwise we use a MongoDB filter+sort. Either path returns the same response
// shape, so the frontend doesn't have to special-case search results.
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { page, limit, offset: skip } = parsePagination(req.query, { limit: DISCUSSIONS_PER_PAGE, maxLimit: DISCUSSIONS_MAX_PER_PAGE });
    const { category, sort, q } = req.query;
    const query = (q || '').toString().trim();

    const validCategory = category && CATEGORIES.includes(category) ? category : null;

    // Language section. Absent means English — the forum's default — so an
    // older client that sends no language keeps seeing exactly what it always
    // saw. 'all' opts out; the subject-scoped lists below use it.
    const languageFilter = await resolveReadableLanguage(coerceStringQuery(req.query.language));

    const filter = {};
    if (languageFilter) {
      // $eq for the same CodeQL reason as category: the value is already
      // constrained (it resolved against the ForumLanguage collection or fell
      // back to the default), but Array/DB lookups aren't recognised as taint
      // cleansers.
      //
      // English ALSO matches threads with no language field at all. A Mongoose
      // default applies when a document is created, never to documents that
      // already exist — so the release that added this field left every
      // pre-existing thread unmatched, and the English forum rendered empty on
      // production until the rows were backfilled (2026-08-31). The backfill
      // is done; this makes the query correct on its own, so a restored
      // snapshot or a document written around the schema cannot empty the
      // forum again. `null` matches missing fields in MongoDB.
      filter.language = languageFilter === DEFAULT_LANGUAGE
        ? { $in: [DEFAULT_LANGUAGE, null] }
        : { $eq: languageFilter };
    }
    // $eq forces literal-value comparison even though `category` is already
    // gated by an allowlist (CATEGORIES.includes). CodeQL doesn't recognise
    // Array.includes() as a taint cleanser, so the `$eq` keeps the
    // `js/sql-injection` rule satisfied without changing behaviour.
    if (validCategory) {
      filter.category = { $eq: validCategory };
    }

    // Threads opened from one blog post — what the post page lists under
    // "Discuss this post".
    const blogPostId = coerceStringQuery(req.query.blogPost).trim();
    if (blogPostId && isValidId(blogPostId)) {
      filter.blogPost = { $eq: new mongoose.Types.ObjectId(blogPostId) };
      // A q combined with the blogPost scope is answered HERE, not by Meili
      // (whose index doesn't carry blogPost — see the skip below). The scoped
      // set is one post's threads, so a title regex over it is trivially
      // cheap; escaped and bounded exactly like the blog search, because the
      // needle is user input (`(((((` is a ReDoS, `?q[$gt]=` is an object).
      if (query) {
        filter.title = new RegExp(escapeRegex(query.slice(0, 120)), 'i');
      }
    } else if (blogPostId) {
      // A malformed id must not silently widen the scope to every discussion.
      return res.json({ discussions: [], total: 0, page, pages: 0 });
    }

    // Meilisearch path: fuzzy match on title/body/authorName/wineName,
    // hydrate hits from MongoDB to keep the response shape consistent.
    //
    // Skipped when a blogPost scope is present (audit 2026-08-21 M-2): the
    // Meili index doesn't carry blogPost, so this branch used to ignore the
    // filter and a q+blogPost request silently widened from "threads about
    // this post" to "all threads matching q" — answering a different question
    // than the one asked. Exact scope beats fuzzy relevance for a post's own
    // thread list, and the Mongo path below applies both together honestly.
    if (query && !filter.blogPost && searchService.getIsAvailable()) {
      try {
        const { ids, estimatedTotalHits } = await searchService.searchDiscussions(query, {
          category: validCategory,
          language: languageFilter,
          limit,
          offset: skip
        });

        if (ids.length === 0) {
          return res.json({ discussions: [], total: estimatedTotalHits, page, pages: Math.ceil(estimatedTotalHits / limit) });
        }

        const docs = await Discussion.find({ _id: { $in: ids } })
          .populate('author', 'username displayName roles plan contribution.tier contribution.specialty')
          .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

        // Preserve Meilisearch relevance ordering
        const byId = new Map(docs.map(d => [d._id.toString(), d]));
        const ordered = ids.map(id => byId.get(id)).filter(Boolean);
        const enrichedSearch = await attachLastReply(ordered);
        const withUnreadSearch = await attachUnreadStatus(enrichedSearch, req.user);

        return res.json({
          discussions: withUnreadSearch,
          total: estimatedTotalHits,
          page,
          pages: Math.ceil(estimatedTotalHits / limit)
        });
      } catch (searchErr) {
        // Fall through to MongoDB path on Meilisearch failure
        console.warn('[discussions] search fallback to MongoDB:', searchErr.message);
      }
    }

    let sortObj;
    switch (sort) {
      case 'newest':
        sortObj = { isPinned: -1, createdAt: -1 };
        break;
      case 'most-replies':
        sortObj = { isPinned: -1, replyCount: -1, lastActivityAt: -1 };
        break;
      case 'trending':
        // Threads with recent activity, ranked by recent reply volume. The
        // 7-day window keeps the tab feeling fresh; pinned threads still float.
        // A truer trending score (replies-in-last-7d × 2 + likes + recency) is
        // a future refinement; this simple proxy already differentiates from
        // "most-replies" (which surfaces all-time-popular threads).
        filter.lastActivityAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
        sortObj = { isPinned: -1, replyCount: -1, lastActivityAt: -1 };
        break;
      default: // 'active' - default sort
        sortObj = { isPinned: -1, lastActivityAt: -1 };
    }

    const [discussions, total] = await Promise.all([
      Discussion.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName roles plan contribution.tier contribution.specialty')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      Discussion.countDocuments(filter)
    ]);

    const enriched = await attachLastReply(discussions);
    const withUnread = await attachUnreadStatus(enriched, req.user);
    res.json({ discussions: withUnread, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List discussions error:', err);
    res.status(500).json({ error: 'Failed to list discussions' });
  }
});

// Helper: tag each discussion with `hasUnread: bool` based on whether the
// requester has visited it before AND there's been activity since their
// last visit. Threads they've never opened don't get the unread flag —
// otherwise every list item would buzz on a first-time visitor.
//
// Anonymous users get hasUnread = false on every item (no read history to
// compare against).
async function attachUnreadStatus(discussions, user) {
  if (!user || !discussions || discussions.length === 0) {
    return (discussions || []).map(d => ({ ...d, hasUnread: false }));
  }
  const ids = discussions.map(d => d._id);
  const reads = await DiscussionRead.find({ user: user.id, discussion: { $in: ids } })
    .select('discussion lastReadAt')
    .lean();
  const lastReadByDiscussion = new Map();
  for (const r of reads) lastReadByDiscussion.set(r.discussion.toString(), r.lastReadAt);
  return discussions.map(d => {
    const lastRead = lastReadByDiscussion.get(d._id.toString());
    const lastActivity = d.lastActivityAt || d.createdAt;
    return {
      ...d,
      hasUnread: !!lastRead && new Date(lastActivity) > new Date(lastRead)
    };
  });
}

// Helper: attach a `lastReply: { author, createdAt }` snippet to each
// discussion in the list. Two queries: aggregate the most-recent non-deleted
// reply per discussion, then populate the author display names. Both are
// indexed scans; cost is proportional to page size (≤30 discussions).
async function attachLastReply(discussions) {
  if (!discussions || discussions.length === 0) return discussions;
  const ids = discussions.map(d => d._id);
  const latestPerDiscussion = await DiscussionReply.aggregate([
    { $match: { discussion: { $in: ids }, isDeleted: { $ne: true } } },
    { $sort: { discussion: 1, createdAt: -1 } },
    { $group: {
        _id: '$discussion',
        author: { $first: '$author' },
        createdAt: { $first: '$createdAt' }
      }
    }
  ]);
  const authorIds = latestPerDiscussion.map(r => r.author).filter(Boolean);
  const authorsById = new Map();
  if (authorIds.length > 0) {
    const users = await User.find({ _id: { $in: authorIds } })
      .select('username displayName')
      .lean();
    for (const u of users) authorsById.set(u._id.toString(), u);
  }
  const lastByDiscussion = new Map();
  for (const r of latestPerDiscussion) {
    const author = authorsById.get(String(r.author)) || null;
    lastByDiscussion.set(r._id.toString(), { author, createdAt: r.createdAt });
  }
  return discussions.map(d => {
    const obj = d.toObject ? d.toObject() : { ...d };
    obj.lastReply = lastByDiscussion.get(d._id.toString()) || null;
    return obj;
  });
}

// ─── Moderation Queue (moderator/admin only) ───────────────────────────────
// These routes MUST be registered before /:id to avoid "moderation" being treated as an ID.

// GET /api/discussions/moderation/reports - List pending reports
router.get('/moderation/reports', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const { page, limit, offset: skip } = parsePagination(req.query, { limit: DISCUSSIONS_PER_PAGE, maxLimit: DISCUSSIONS_MAX_PER_PAGE });
    const VALID_STATUSES = ['pending', 'resolved', 'dismissed'];
    const status = VALID_STATUSES.includes(req.query.status) ? req.query.status : 'pending';

    const [reports, total] = await Promise.all([
      DiscussionReport.find({ status })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('user', 'username displayName')
        .populate({ path: 'discussion', select: 'title author', populate: { path: 'author', select: 'username displayName' } })
        .populate({ path: 'reply', select: 'body author discussion', populate: { path: 'author', select: 'username displayName' } }),
      DiscussionReport.countDocuments({ status })
    ]);

    res.json({ reports, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List reports error:', err);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// PATCH /api/discussions/moderation/reports/:reportId - Resolve a report
router.patch('/moderation/reports/:reportId', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.reportId)) return res.status(400).json({ error: 'Invalid report ID' });
    const report = await DiscussionReport.findById(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const { status } = req.body;
    if (!status || !['resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "resolved" or "dismissed"' });
    }

    report.status = status;
    report.resolvedBy = req.user.id;
    report.resolvedAt = new Date();
    await report.save();

    logAudit(req, 'discussion_report.resolve', { type: 'discussion_report', id: report._id }, { status });

    res.json({ report });
  } catch (err) {
    console.error('Resolve report error:', err);
    res.status(500).json({ error: 'Failed to resolve report' });
  }
});

// ─── User Banning (moderator/admin) ─────────────────────────────────────────
// Registered before /:id to avoid "moderation" being treated as an ID.

const BAN_DURATIONS = {
  '10m':  10 * 60 * 1000,
  '1h':   60 * 60 * 1000,
  '1d':   24 * 60 * 60 * 1000,
  '1w':   7 * 24 * 60 * 60 * 1000,
  'permanent': null
};

// POST /api/discussions/moderation/ban - Ban a user from discussions
router.post('/moderation/ban', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    if (!userId || !isValidId(userId)) return res.status(400).json({ error: 'Invalid user ID' });
    if (!duration || !Object.prototype.hasOwnProperty.call(BAN_DURATIONS, duration)) {
      return res.status(400).json({ error: `Duration must be one of: ${Object.keys(BAN_DURATIONS).join(', ')}` });
    }

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    // Don't allow banning other mods/admins
    if (targetUser.roles.includes('moderator') || targetUser.roles.includes('admin')) {
      return res.status(403).json({ error: 'Cannot ban moderators or admins' });
    }

    const durationMs = BAN_DURATIONS[duration];
    targetUser.discussionBan = {
      active: true,
      reason: reason ? stripHtml(reason) : null,
      bannedAt: new Date(),
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : null,
      bannedBy: req.user.id
    };

    await targetUser.save();
    logAudit(req, 'discussion_ban.create', { type: 'user', id: targetUser._id }, { duration, reason });

    res.json({
      message: `User banned for ${duration}`,
      ban: targetUser.discussionBan
    });
  } catch (err) {
    console.error('Ban user error:', err);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

// DELETE /api/discussions/moderation/ban/:userId - Unban a user
router.delete('/moderation/ban/:userId', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.userId)) return res.status(400).json({ error: 'Invalid user ID' });
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    targetUser.discussionBan = {
      active: false,
      reason: null,
      bannedAt: null,
      expiresAt: null,
      bannedBy: null
    };

    await targetUser.save();
    logAudit(req, 'discussion_ban.remove', { type: 'user', id: targetUser._id });

    res.json({ message: 'User unbanned' });
  } catch (err) {
    console.error('Unban user error:', err);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// GET /api/discussions/:idOrSlug - Single discussion (public). Accepts both
// ObjectId and human-readable slug. The frontend swaps the URL to the slug form
// via history.replaceState() once it has the response.
router.get('/:idOrSlug', optionalAuth, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const filter = isValidId(idOrSlug)
      ? { _id: idOrSlug }
      : { slug: String(idOrSlug).toLowerCase() };

    const discussion = await Discussion.findOne(filter)
      .populate('author', 'username displayName roles plan contribution.tier contribution.specialty')
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    // Watch status: total followers + whether the requester is one of them.
    // Anonymous viewers get isWatching=false.
    const [watcherCount, myWatch] = await Promise.all([
      DiscussionWatch.countDocuments({ discussion: discussion._id }),
      req.user
        ? DiscussionWatch.findOne({ user: req.user.id, discussion: discussion._id }).select('_id').lean()
        : Promise.resolve(null)
    ]);

    // Top participants — distinct reply authors (excluding the OP, who is
    // shown separately as the thread anchor). Capped at 6 with totalCount
    // for the "+N more" overflow chip. Note: `author` is populated above, so
    // compare against its _id — aggregation pipelines are not casted by
    // Mongoose, and a populated document never equals a stored ObjectId.
    const participantAgg = await DiscussionReply.aggregate([
      { $match: { discussion: discussion._id, isDeleted: { $ne: true }, author: { $ne: discussion.author?._id ?? null } } },
      { $group: { _id: '$author', firstAt: { $min: '$createdAt' } } },
      { $sort: { firstAt: 1 } }
    ]);
    const totalParticipants = participantAgg.length;
    const topAuthorIds = participantAgg.slice(0, 6).map(p => p._id);
    let participants = [];
    if (topAuthorIds.length > 0) {
      const users = await User.find({ _id: { $in: topAuthorIds } })
        .select('username displayName')
        .lean();
      const byId = new Map(users.map(u => [u._id.toString(), u]));
      participants = topAuthorIds.map(id => byId.get(id.toString())).filter(Boolean);
    }

    const obj = discussion.toObject();
    obj.watcherCount = watcherCount;
    obj.isWatching = !!myWatch;
    obj.participants = participants;
    obj.totalParticipants = totalParticipants;
    res.json({ discussion: obj });
  } catch (err) {
    console.error('Get discussion error:', err);
    res.status(500).json({ error: 'Failed to get discussion' });
  }
});

// POST /api/discussions - Create a discussion
router.post('/', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (await checkDiscussionBan(req, res)) return;

    const { title, body, category, wineDefinition, blogPost } = req.body;

    if (!title || !body || !category) {
      return res.status(400).json({ error: 'Title, body, and category are required' });
    }
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (wineDefinition && !isValidId(wineDefinition)) {
      return res.status(400).json({ error: 'Invalid wine definition ID' });
    }
    // A thread opened from a blog post. Verified to EXIST and to be PUBLISHED,
    // for the same reason the wine above is verified: a discussion is
    // anonymously readable and crawler-rendered, so a bad ref would publish a
    // link to a draft or to nothing. Cast after validating to clear taint.
    let blogOid = null;
    if (blogPost) {
      if (!isValidId(blogPost)) {
        return res.status(400).json({ error: 'Invalid blog post ID' });
      }
      const post = await BlogPost.findOne({
        _id: new mongoose.Types.ObjectId(String(blogPost)), status: 'published',
      }).select('_id');
      if (!post) {
        return res.status(400).json({ error: 'No such published blog post' });
      }
      blogOid = post._id;
    }
    // Verify the wine actually exists (the reply path does the same) — a
    // stale picker id would create a thread whose wine chip silently never
    // renders and whose og page omits the wine link. Cast the validated id
    // to a real ObjectId before it touches the query (clears taint tracking).
    const wineOid = wineDefinition ? new mongoose.Types.ObjectId(String(wineDefinition)) : null;
    if (wineOid) {
      // ABSOLUTE pendingIdentity gate — not the creator-aware one. A discussion
      // is anonymously readable (optionalAuth), its wine is populated into the
      // response, baked into the anonymously-searchable discussion Meili index
      // and rendered for CRAWLERS by routes/og.js. So even the row's own
      // creator must not be able to publish it: attaching is what would make a
      // hidden half-identified wine public (security audit). Refused at WRITE
      // time, which closes every downstream read path at once.
      const wineExists = await WineDefinition.exists({ _id: wineOid, pendingIdentity: { $ne: true } });
      if (!wineExists) return res.status(400).json({ error: 'Wine not found' });
    }

    const cleanTitle = stripHtml(title);
    const cleanBody = sanitizeForumHtml(body);
    const visibleLength = visibleTextLength(cleanBody);

    if (cleanTitle.length < 3) return res.status(400).json({ error: 'Title must be at least 3 characters' });
    if (cleanTitle.length > DISCUSSION_MAX_LENGTHS.title) return res.status(400).json({ error: `Title too long (max ${DISCUSSION_MAX_LENGTHS.title} characters)` });
    if (visibleLength < 10) return res.status(400).json({ error: 'Body must be at least 10 characters' });
    if (visibleLength > DISCUSSION_MAX_LENGTHS.body) return res.status(400).json({ error: `Body too long (max ${DISCUSSION_MAX_LENGTHS.body} characters)` });

    // Language section. Absent → English, so a client that never sends one
    // posts to the default section exactly as before. An unknown or closed
    // code is a 400 rather than a silent fallback: quietly filing a French
    // thread in the English forum is the mis-file this feature exists to
    // prevent.
    const lang = await resolveWritableLanguage(req.body.language);
    if (lang.error) return res.status(400).json({ error: lang.error });

    const discussion = new Discussion({
      author: req.user.id,
      title: cleanTitle,
      body: cleanBody,
      category,
      language: lang.code,
      wineDefinition: wineDefinition || null,
      blogPost: blogOid
    });

    await discussion.save();
    incrementCred(req.user.id, 'discussion_created').catch(() => {});
    logAudit(req, 'discussion.create', { type: 'discussion', id: discussion._id }, { title: cleanTitle, category, language: lang.code });

    // Auto-watch: posting a discussion implies you want updates on it.
    DiscussionWatch.updateOne(
      { user: req.user.id, discussion: discussion._id },
      { $setOnInsert: { user: req.user.id, discussion: discussion._id } },
      { upsert: true }
    ).catch(() => {});

    // Notify search engines about the new public-readable URL
    submitToIndexNow(`/community/discussions/${discussion.slug || discussion._id}`);
    // Index in Meilisearch for in-forum search (fire-and-forget)
    searchService.indexDiscussion(discussion._id);

    await discussion.populate('author', 'username displayName roles plan contribution.tier contribution.specialty');

    // Notify @mentioned users — dispatched after the response would normally be
    // optimal, but since createNotification is fire-and-forget internally, calling
    // it before res.json() doesn't add latency.
    const authorName = discussion.author?.displayName || discussion.author?.username || 'Someone';
    const link = `/community/discussions/${discussion.slug || discussion._id}`;
    const mentionedIds = await extractMentions(cleanBody, req.user.id);
    for (const uid of mentionedIds) {
      createNotification(
        uid,
        'discussion_mention',
        `${authorName} mentioned you`,
        `In a new discussion: "${cleanTitle}"`,
        link,
        'communityMention',
        req.user.id // actor — lets GDPR erasure remove this on the author's deletion
      );
    }

    res.status(201).json({ discussion });
  } catch (err) {
    console.error('Create discussion error:', err);
    res.status(500).json({ error: 'Failed to create discussion' });
  }
});

// DELETE /api/discussions/:idOrSlug - Delete discussion (moderator/admin only)
router.delete('/:idOrSlug', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    // Clean up replies, reactions, watches, reads, and reports — both reports
    // filed against the discussion itself AND reports against any of its
    // replies (the reply IDs go away in the next step, leaving orphan reports
    // pointing at deleted documents in the moderation queue otherwise).
    const replyIds = await DiscussionReply.find({ discussion: discussion._id }).select('_id author isDeleted');
    const replyIdList = replyIds.map(r => r._id);

    // Collect the Cellar-Cred these documents awarded BEFORE deleting them so
    // the hard delete reverses the awards symmetrically (L-19): +2 to the
    // discussion author, +1 per live reply to its author, +1 per non-self
    // reaction to the reacted reply's author. Soft-deleted replies already had
    // their reply-created point reversed at soft-delete time, so they are
    // skipped here — but their reactions were never reversed, so those aren't.
    const credReversals = new Map(); // userId -> { eventType -> count }
    const addReversal = (userId, eventType, n = 1) => {
      if (!userId) return;
      const key = userId.toString();
      const events = credReversals.get(key) || {};
      events[eventType] = (events[eventType] || 0) + n;
      credReversals.set(key, events);
    };
    addReversal(discussion.author, 'discussion_created');
    const authorByReply = new Map();
    for (const r of replyIds) {
      authorByReply.set(r._id.toString(), r.author?.toString());
      if (!r.isDeleted) addReversal(r.author, 'discussion_reply_created');
    }
    const reactionRows = await DiscussionReaction.find({ reply: { $in: replyIdList } }).select('reply user').lean();
    for (const rx of reactionRows) {
      const replyAuthor = authorByReply.get(rx.reply?.toString());
      if (replyAuthor && replyAuthor !== rx.user?.toString()) {
        addReversal(replyAuthor, 'reply_like_received');
      }
    }
    // Await the cleanups BEFORE deleting the parent — if one fails the 500
    // leaves the discussion intact so the delete can be retried, instead of
    // permanently orphaning replies/reactions/reports.
    await Promise.all([
      DiscussionReaction.deleteMany({ reply: { $in: replyIdList } }),
      DiscussionReply.deleteMany({ discussion: discussion._id }),
      DiscussionReport.deleteMany({
        $or: [
          { discussion: discussion._id },
          { reply: { $in: replyIdList } }
        ]
      }),
      DiscussionWatch.deleteMany({ discussion: discussion._id }),
      DiscussionRead.deleteMany({ discussion: discussion._id })
    ]);

    // Capture the public URL before deletion so we can ping IndexNow afterwards.
    const publicPath = `/community/discussions/${discussion.slug || discussion._id}`;
    const deletedId = discussion._id;
    await Discussion.deleteOne({ _id: discussion._id });
    logAudit(req, 'discussion.delete', { type: 'discussion', id: deletedId });

    // Apply the collected reversals now that the deletes succeeded.
    // Fire-and-forget like every other cred write; decrementCred clamps at 0.
    for (const [userId, events] of credReversals) {
      for (const [eventType, count] of Object.entries(events)) {
        decrementCred(userId, eventType, count).catch(() => {});
      }
    }

    // Tell crawlers the URL is gone (ping returns 404 on next crawl → drop from index)
    submitToIndexNow(publicPath);
    // Drop from Meilisearch so search results don't show ghost threads
    searchService.removeDiscussion(deletedId);

    res.json({ message: 'Discussion deleted' });
  } catch (err) {
    console.error('Delete discussion error:', err);
    res.status(500).json({ error: 'Failed to delete discussion' });
  }
});

// ─── Replies ────────────────────────────────────────────────────────────────

// GET /api/discussions/:idOrSlug/replies - List replies for a discussion (public).
// :idOrSlug accepts both ObjectId and slug; we resolve it to an ObjectId before
// querying replies (which always reference the discussion by ObjectId).
router.get('/:idOrSlug/replies', optionalAuth, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    let discussionId;
    if (isValidId(idOrSlug)) {
      discussionId = idOrSlug;
    } else {
      const discussion = await Discussion.findOne({ slug: String(idOrSlug).toLowerCase() }).select('_id');
      if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
      discussionId = discussion._id;
    }
    const { page, limit, offset: skip } = parsePagination(req.query, { limit: DISCUSSIONS_PER_PAGE, maxLimit: DISCUSSIONS_MAX_PER_PAGE });

    const [replies, total] = await Promise.all([
      DiscussionReply.find({ discussion: discussionId })
        .sort({ createdAt: 1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username displayName roles plan contribution.tier contribution.specialty')
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } }),
      DiscussionReply.countDocuments({ discussion: discussionId })
    ]);

    // Aggregate reaction counts per (reply, kind) for the page in one query
    // and, when the requester is logged in, also pull which kinds they've
    // reacted with so the UI can render the toggle state.
    const replyIds = replies.map(r => r._id);
    const reactionCountsByReply = new Map(); // replyId → { kind: count }
    const myReactionsByReply = new Map();    // replyId → [kind]

    if (replyIds.length > 0) {
      const counts = await DiscussionReaction.aggregate([
        { $match: { reply: { $in: replyIds } } },
        { $group: { _id: { reply: '$reply', kind: '$kind' }, count: { $sum: 1 } } }
      ]);
      for (const row of counts) {
        const replyKey = row._id.reply.toString();
        if (!reactionCountsByReply.has(replyKey)) reactionCountsByReply.set(replyKey, {});
        reactionCountsByReply.get(replyKey)[row._id.kind] = row.count;
      }

      if (req.user) {
        const mine = await DiscussionReaction.find({
          user: req.user.id,
          reply: { $in: replyIds }
        }).select('reply kind').lean();
        for (const r of mine) {
          const replyKey = r.reply.toString();
          if (!myReactionsByReply.has(replyKey)) myReactionsByReply.set(replyKey, []);
          myReactionsByReply.get(replyKey).push(r.kind);
        }
      }
    }

    const isMod = isModerator(req.user);
    const enriched = replies.map(r => {
      const obj = r.toObject();
      const replyKey = r._id.toString();
      obj.reactions = reactionCountsByReply.get(replyKey) || {};
      obj.myReactions = myReactionsByReply.get(replyKey) || [];
      // Never leak deletedBody to non-mods (or anonymous viewers)
      if (!isMod) delete obj.deletedBody;
      return obj;
    });

    // Mark this thread as read for the current user. Fire-and-forget upsert
    // — the response doesn't depend on it, and a transient failure shouldn't
    // surface to the caller. Reading replies is the strongest "I've seen
    // this thread" signal (the user is actively scrolling content).
    if (req.user) {
      DiscussionRead.findOneAndUpdate(
        { user: req.user.id, discussion: discussionId },
        { $set: { lastReadAt: new Date() } },
        { upsert: true }
      ).catch(() => {});
    }

    res.json({ replies: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('List replies error:', err);
    res.status(500).json({ error: 'Failed to list replies' });
  }
});

// POST /api/discussions/:idOrSlug/replies - Create a reply
router.post('/:idOrSlug/replies', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (await checkDiscussionBan(req, res)) return;

    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
    if (discussion.isLocked) {
      return res.status(403).json({ error: 'This discussion is locked' });
    }

    const { body, quote, wineDefinition: wineDefId } = req.body;
    if (!body) return res.status(400).json({ error: 'Reply body is required' });

    const cleanBody = sanitizeForumHtml(body);
    const visibleLength = visibleTextLength(cleanBody);
    if (visibleLength < 1) return res.status(400).json({ error: 'Reply cannot be empty' });
    if (visibleLength > DISCUSSION_MAX_LENGTHS.replyBody) return res.status(400).json({ error: 'Reply too long' });

    // Build quote snapshot if quoting another reply
    let quoteData = {};
    let quotedAuthorId = null;
    if (quote && quote.replyId && isValidId(quote.replyId)) {
      const quotedReply = await DiscussionReply.findById(quote.replyId).populate('author', 'username displayName');
      if (quotedReply) {
        const quotedName = quotedReply.author?.displayName || quotedReply.author?.username || 'Unknown';
        // Strip the quoted body to plain text before truncating — slicing raw
        // HTML would split tags ("<stro|ng>") and break rendering. The quote
        // is rendered in a styled blockquote, so plain text is the right form.
        const quotedPlain = stripHtml(quotedReply.body || '');
        const snippetBody = quotedPlain.length > 300
          ? quotedPlain.slice(0, 300) + '…'
          : quotedPlain;
        // authorId is persisted alongside the denormalised name snapshot so
        // GDPR erasure can find and anonymise quote.authorName on OTHER
        // users' replies when the quoted author deletes their account (L-17).
        quotedAuthorId = quotedReply.author?._id || null;
        quoteData = {
          replyId: quotedReply._id,
          authorId: quotedAuthorId,
          authorName: quotedName,
          body: snippetBody
        };
      }
    }

    // Validate wine reference if provided
    let validWineId = null;
    if (wineDefId && isValidId(wineDefId)) {
      // Same absolute gate as the create path above — a reply's wine chip is
      // rendered to anonymous readers and to crawlers too. This path drops an
      // unusable id silently (it always has), so a pending one just doesn't
      // attach rather than failing the reply.
      const wine = await WineDefinition.findOne({ _id: wineDefId, pendingIdentity: { $ne: true } }).select('_id');
      if (wine) validWineId = wine._id;
    }

    const reply = new DiscussionReply({
      discussion: discussion._id,
      author: req.user.id,
      body: cleanBody,
      quote: quoteData.replyId ? quoteData : undefined,
      wineDefinition: validWineId
    });

    await reply.save();
    incrementCred(req.user.id, 'discussion_reply_created').catch(() => {});

    // Update discussion counters
    Discussion.updateOne(
      { _id: discussion._id },
      { $inc: { replyCount: 1 }, $set: { lastActivityAt: new Date() } }
    ).catch(() => {});

    // The thread's lastmod just changed — let search engines re-crawl
    submitToIndexNow(`/community/discussions/${discussion.slug || discussion._id}`);
    // Re-index so the trending/active sort and search reflect new replyCount/lastActivityAt
    searchService.indexDiscussion(discussion._id);

    // Auto-watch: replying is an engagement signal that you want updates on
    // this thread. Idempotent via the (user, discussion) unique index.
    DiscussionWatch.updateOne(
      { user: req.user.id, discussion: discussion._id },
      { $setOnInsert: { user: req.user.id, discussion: discussion._id } },
      { upsert: true }
    ).catch(() => {});

    // Notification fan-out priority order:
    //   1. OP (highest signal — your thread got a new reply)
    //   2. Quoted-author (someone quoted you)
    //   3. @mentioned users (you were tagged)
    //   4. Watchers (lowest signal — your followed thread got activity)
    //
    // Each user is notified at most once per reply event (Set dedupe). Each
    // category has its own granular email/push preferences (drinkWindow,
    // communityReply, communityMention, communityFollow); email/push fire
    // only when the recipient opted in for that category.
    const replier = await User.findById(req.user.id).select('username displayName');
    const replierName = replier?.displayName || replier?.username || 'Someone';
    const link = `/community/discussions/${discussion.slug || discussion._id}`;
    const fullUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}${link}`;
    const replyTextPreview = stripHtml(cleanBody).slice(0, 280);
    const notified = new Set();
    const selfId = String(req.user.id);

    // Helper: fire an email for a notification category if the recipient
    // opted into email for that category. Fire-and-forget; never blocks the
    // reply create. The email-template `kind` differs from the prefs category
    // (e.g. quote/reply both gated by communityReply).
    async function maybeEmail(recipientId, prefsCategory, emailKind) {
      if (!EMAIL_VERIFICATION_ENABLED) return;
      try {
        const recipient = await User.findById(recipientId)
          .select('email displayName username preferences.notifications emailVerified');
        if (!recipient || !recipient.email || !recipient.emailVerified) return;
        const cat = recipient.preferences?.notifications?.[prefsCategory];
        if (!cat?.email) return;
        const recipientName = recipient.displayName || recipient.username || 'there';
        await sendDiscussionReplyEmail(
          recipient.email,
          recipientName,
          recipientId.toString(),
          replierName,
          discussion.title,
          fullUrl,
          replyTextPreview,
          emailKind
        );
      } catch (err) {
        console.warn(`[email-on-reply] failed for ${recipientId}:`, err.message);
      }
    }

    // Collect every recipient first, then deliver in ONE batch — a popular
    // thread can have hundreds of watchers, and per-recipient
    // createNotification calls fan out 3 queries + push HTTPS calls each,
    // all inside this request handler.
    const notificationItems = [];

    if (String(discussion.author) !== selfId) {
      notified.add(String(discussion.author));
      notificationItems.push({
        userId: discussion.author,
        type: 'discussion_reply',
        title: 'New reply to your discussion',
        message: `${replierName} replied to "${discussion.title}"`,
        link,
        category: 'communityReply',
      });
      maybeEmail(discussion.author, 'communityReply', 'reply');
    }

    if (quotedAuthorId && String(quotedAuthorId) !== selfId && !notified.has(String(quotedAuthorId))) {
      notified.add(String(quotedAuthorId));
      notificationItems.push({
        userId: quotedAuthorId,
        type: 'discussion_reply',
        title: `${replierName} quoted you`,
        message: `In "${discussion.title}"`,
        link,
        category: 'communityReply',
      });
      maybeEmail(quotedAuthorId, 'communityReply', 'quote');
    }

    // Mention/watcher resolution is best-effort: the reply is already saved,
    // so a failure here must not 500 the request or lose the OP/quote
    // notifications already collected above.
    try {
      const mentionedIds = await extractMentions(cleanBody, req.user.id);
      for (const uid of mentionedIds) {
        if (notified.has(uid)) continue;
        notified.add(uid);
        notificationItems.push({
          userId: uid,
          type: 'discussion_mention',
          title: `${replierName} mentioned you`,
          message: `In "${discussion.title}"`,
          link,
          category: 'communityMention',
        });
        maybeEmail(uid, 'communityMention', 'mention');
      }

      // Watchers — anyone following this thread who isn't already covered.
      // Lower-priority notification ("There's a new reply on a thread you
      // follow") so the title differs from the OP-owns-the-thread case.
      // Push delivery is gated per-user via the 'communityFollow' category;
      // no email channel for this category by design (would be too noisy).
      const watchers = await DiscussionWatch.find({ discussion: discussion._id })
        .select('user').lean();
      for (const w of watchers) {
        const uid = w.user.toString();
        if (uid === selfId || notified.has(uid)) continue;
        notified.add(uid);
        notificationItems.push({
          userId: uid,
          type: 'discussion_reply',
          title: `New reply in "${discussion.title}"`,
          message: `${replierName} replied — you're following this thread`,
          link,
          category: 'communityFollow',
        });
      }
    } catch (err) {
      console.error('[discussions] mention/watcher resolution failed:', err.message);
    }

    // Fire-and-forget, same as the old per-recipient calls — delivery must
    // never block or fail the reply create. Every item here is triggered by the
    // replier, so tag them with actor so GDPR erasure can remove notifications
    // that name this user from other users' feeds on their deletion.
    createNotifications(notificationItems.map(i => ({ ...i, actor: req.user.id }))).catch(err =>
      console.error('[discussions] reply notification batch failed:', err.message)
    );

    logAudit(req, 'discussion_reply.create', { type: 'discussion_reply', id: reply._id }, { discussion: discussion._id });

    await reply.populate('author', 'username displayName roles plan contribution.tier contribution.specialty');
    await reply.populate({ path: 'wineDefinition', select: 'name producer type', populate: { path: 'country', select: 'name' } });

    res.status(201).json({ reply });
  } catch (err) {
    console.error('Create reply error:', err);
    res.status(500).json({ error: 'Failed to create reply' });
  }
});

// PUT /api/discussions/:discussionId/replies/:replyId - Update own reply
router.put('/:discussionId/replies/:replyId', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (reply.isDeleted) return res.status(400).json({ error: 'Reply has been deleted' });

    const isOwner = reply.author.toString() === req.user.id;
    const isMod = isModerator(req.user);
    if (!isOwner && !isMod) {
      return res.status(403).json({ error: 'You can only edit your own replies' });
    }

    const { body } = req.body;
    if (body !== undefined) {
      const cleanBody = sanitizeForumHtml(body);
      const visibleLength = visibleTextLength(cleanBody);
      if (visibleLength < 1) return res.status(400).json({ error: 'Reply cannot be empty' });
      if (visibleLength > DISCUSSION_MAX_LENGTHS.replyBody) return res.status(400).json({ error: 'Reply too long' });
      reply.body = cleanBody;
    }

    await reply.save();
    logAudit(req, 'discussion_reply.update', { type: 'discussion_reply', id: reply._id });

    // Re-index the parent discussion so search results pick up the edited
    // reply content. Fire-and-forget; never blocks the response.
    searchService.indexDiscussion(reply.discussion);

    await reply.populate('author', 'username displayName roles plan contribution.tier contribution.specialty');
    res.json({ reply });
  } catch (err) {
    console.error('Update reply error:', err);
    res.status(500).json({ error: 'Failed to update reply' });
  }
});

// DELETE /api/discussions/:discussionId/replies/:replyId - Soft-delete reply (user or mod/admin)
router.delete('/:discussionId/replies/:replyId', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (reply.isDeleted) return res.status(400).json({ error: 'Reply already deleted' });

    const isOwner = reply.author.toString() === req.user.id;
    const isMod = isModerator(req.user);
    if (!isOwner && !isMod) {
      return res.status(403).json({ error: 'You can only delete your own replies' });
    }

    // Soft-delete: stash original body, replace with placeholder
    reply.deletedBody = reply.body;
    reply.body = '[This reply has been removed]';
    reply.isDeleted = true;
    reply.deletedAt = new Date();
    await reply.save();

    // Reverse the +1 the reply's creation awarded (L-19) — a create/delete
    // cycle nets zero. The isDeleted guard above makes this once-only (there
    // is no un-delete). Reaction cred is NOT reversed here: reactions stay on
    // the soft-deleted reply and remain toggleable, so their accounting stays
    // with the toggle handlers.
    decrementCred(reply.author.toString(), 'discussion_reply_created').catch(() => {});

    logAudit(req, 'discussion_reply.soft_delete', { type: 'discussion_reply', id: reply._id });

    // Re-index parent so search drops this reply's content (the index
    // helper filters out isDeleted replies).
    searchService.indexDiscussion(reply.discussion);

    // Soft-deleted replies still hold their reactions for moderator review,
    // but reports filed AGAINST a since-deleted reply lose their value (the
    // mod queue would point at "[This reply has been removed]"). Drop them.
    DiscussionReport.deleteMany({ reply: reply._id }).catch(() => {});

    res.json({ message: 'Reply deleted', reply: reply.toObject() });
  } catch (err) {
    console.error('Delete reply error:', err);
    res.status(500).json({ error: 'Failed to delete reply' });
  }
});

// GET /api/discussions/:discussionId/replies/:replyId/original - View original text of deleted reply (mod/admin)
router.get('/:discussionId/replies/:replyId/original', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const reply = await DiscussionReply.findById(req.params.replyId).select('deletedBody isDeleted');
    if (!reply) return res.status(404).json({ error: 'Reply not found' });
    if (!reply.isDeleted) return res.status(400).json({ error: 'Reply is not deleted' });

    res.json({ originalBody: reply.deletedBody });
  } catch (err) {
    console.error('Get original reply error:', err);
    res.status(500).json({ error: 'Failed to get original reply' });
  }
});

// POST /api/discussions/:discussionId/replies/:replyId/reactions - Toggle a
// reaction kind on a reply. Body: { kind: 'thumbs_up' | 'heart' | 'cheers' |
// 'wine' | 'thinking' | 'target' | 'laugh' | 'pray' }. Idempotent toggle:
// the same kind twice flips off, a different kind adds independently.
//
// Self-reactions are allowed (Slack/Discord/GitHub all do this — letting an
// author 🥂 their own answer is a normal interaction).
router.post('/:discussionId/replies/:replyId/reactions', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });
    const { kind } = req.body || {};
    if (!kind || !REACTION_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Invalid reaction kind. Allowed: ${REACTION_KINDS.join(', ')}` });
    }

    const reply = await DiscussionReply.findById(req.params.replyId).select('_id author');
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    // $eq forces literal-value comparison, blocking NoSQL operator injection
    // even though `kind` is already validated against REACTION_KINDS above.
    // CodeQL doesn't recognise Array.includes() as a taint cleanser, so this
    // also keeps the `js/sql-injection` rule satisfied.
    const existing = await DiscussionReaction.findOne({
      user: req.user.id,
      reply: reply._id,
      kind: { $eq: kind }
    });

    if (existing) {
      const del = await DiscussionReaction.deleteOne({ _id: existing._id });
      // Symmetric cred (L-19): the reaction awarded +1 to the reply author, so
      // removing it takes the point back — a react/un-react toggle loop nets
      // zero instead of +1 per cycle (×8 kinds). Guarded by deletedCount so a
      // concurrent double-un-react can't double-reverse; self-reactions never
      // awarded cred, so they never reverse it either.
      if (del.deletedCount > 0 && reply.author.toString() !== req.user.id) {
        decrementCred(reply.author.toString(), 'reply_like_received').catch(() => {});
      }
      const counts = await reactionCountsForReply(reply._id);
      return res.json({ reacted: false, kind, reactions: counts });
    }

    await new DiscussionReaction({ user: req.user.id, reply: reply._id, kind }).save();
    // Award contribution credit on the reply author when a different user
    // reacts (kind-agnostic — any reaction is positive engagement).
    if (reply.author.toString() !== req.user.id) {
      incrementCred(reply.author.toString(), 'reply_like_received').catch(() => {});
    }
    const counts = await reactionCountsForReply(reply._id);
    res.json({ reacted: true, kind, reactions: counts });
  } catch (err) {
    console.error('Toggle reaction error:', err);
    res.status(500).json({ error: 'Failed to toggle reaction' });
  }
});

// Helper: reaction counts (by kind) for a single reply. Kept inline near the
// route since it's only used by the reaction toggle.
async function reactionCountsForReply(replyId) {
  const rows = await DiscussionReaction.aggregate([
    { $match: { reply: replyId } },
    { $group: { _id: '$kind', count: { $sum: 1 } } }
  ]);
  return Object.fromEntries(rows.map(r => [r._id, r.count]));
}

// POST /api/discussions/:idOrSlug/watch - Follow this thread.
// DELETE same path - Unfollow.
//
// Watchers receive notifications for new replies on the thread (via the
// reply fan-out), in addition to the existing OP/quoted/mention paths.
// Idempotent: re-following a thread you already watch returns 200 without
// creating duplicates (the unique index on (user, discussion) backstops it).
router.post('/:idOrSlug/watch', requireAuth, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const result = await DiscussionWatch.updateOne(
      { user: req.user.id, discussion: discussion._id },
      { $setOnInsert: { user: req.user.id, discussion: discussion._id } },
      { upsert: true }
    );
    if (result.upsertedCount > 0) {
      logAudit(req, 'discussion.watch', { type: 'discussion', id: discussion._id });
    }
    res.json({ watching: true });
  } catch (err) {
    console.error('Watch discussion error:', err);
    res.status(500).json({ error: 'Failed to follow discussion' });
  }
});

router.delete('/:idOrSlug/watch', requireAuth, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const result = await DiscussionWatch.deleteOne({ user: req.user.id, discussion: discussion._id });
    if (result.deletedCount > 0) {
      logAudit(req, 'discussion.unwatch', { type: 'discussion', id: discussion._id });
    }
    res.json({ watching: false });
  } catch (err) {
    console.error('Unwatch discussion error:', err);
    res.status(500).json({ error: 'Failed to unfollow discussion' });
  }
});

// ─── Moderation ─────────────────────────────────────────────────────────────

// PATCH /api/discussions/:idOrSlug/pin - Toggle pin (moderator/admin only)
router.patch('/:idOrSlug/pin', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    discussion.isPinned = !discussion.isPinned;
    await discussion.save();
    logAudit(req, 'discussion.pin', { type: 'discussion', id: discussion._id }, { isPinned: discussion.isPinned });

    // Re-index so the search filter on `isPinned` and the trending/active sort
    // ordering reflect the toggle. Without this the search index goes stale.
    searchService.indexDiscussion(discussion._id);

    res.json({ discussion });
  } catch (err) {
    console.error('Toggle pin error:', err);
    res.status(500).json({ error: 'Failed to toggle pin' });
  }
});

// PATCH /api/discussions/:idOrSlug/language - Move a thread to another language
// section (moderator/admin only).
//
// The sanctioned response to a thread written in the wrong section: English is
// the default forum, and someone posting in their own language there has
// mis-filed rather than misbehaved, so a moderator MOVES it (Johan,
// 2026-08-31). Deliberately not a delete, not a lock, and not a notification —
// the thread and its replies are untouched, and the author is not told off for
// a filing decision they were never asked to make.
//
// A retired section is a valid target (see forumLanguages.resolveMoveTarget):
// tidying the last threads of a closed section is exactly what a move is for.
router.patch('/:idOrSlug/language', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const target = await resolveMoveTarget(req.body?.language);
    if (target.error) return res.status(400).json({ error: target.error });

    const from = discussion.language || 'en';
    if (from === target.code) return res.json({ discussion, unchanged: true });

    discussion.language = target.code;
    await discussion.save();
    logAudit(req, 'discussion.language.move', { type: 'discussion', id: discussion._id },
      { from, to: target.code, title: discussion.title });

    // The thread's language filter changed — without a re-index it keeps
    // answering searches scoped to the section it just left.
    searchService.indexDiscussion(discussion._id);

    res.json({ discussion });
  } catch (err) {
    console.error('Move discussion language error:', err);
    res.status(500).json({ error: 'Failed to move discussion' });
  }
});

// PATCH /api/discussions/:idOrSlug/lock - Toggle lock (moderator/admin only)
router.patch('/:idOrSlug/lock', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    discussion.isLocked = !discussion.isLocked;
    await discussion.save();
    logAudit(req, 'discussion.lock', { type: 'discussion', id: discussion._id }, { isLocked: discussion.isLocked });

    // Locking changes the page meaning — re-ping crawlers to refresh their snapshot
    submitToIndexNow(`/community/discussions/${discussion.slug || discussion._id}`);
    // Re-index so the search filter on `isLocked` reflects the toggle.
    searchService.indexDiscussion(discussion._id);

    res.json({ discussion });
  } catch (err) {
    console.error('Toggle lock error:', err);
    res.status(500).json({ error: 'Failed to toggle lock' });
  }
});

// PATCH /api/discussions/:idOrSlug/move - Move to different category (moderator/admin only)
router.patch('/:idOrSlug/move', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const { category } = req.body;
    if (!category || !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const oldCategory = discussion.category;
    discussion.category = category;
    await discussion.save();
    logAudit(req, 'discussion.move', { type: 'discussion', id: discussion._id }, { from: oldCategory, to: category });

    // Re-index so the search filter on `category` reflects the move.
    searchService.indexDiscussion(discussion._id);

    res.json({ discussion });
  } catch (err) {
    console.error('Move discussion error:', err);
    res.status(500).json({ error: 'Failed to move discussion' });
  }
});

// ─── Reporting ──────────────────────────────────────────────────────────────

// POST /api/discussions/:idOrSlug/report - Report a discussion
router.post('/:idOrSlug/report', requireAuth, requireNonDemo, async (req, res) => {
  try {
    const discussion = await findDiscussionByIdOrSlug(req.params.idOrSlug);
    if (!discussion) return res.status(404).json({ error: 'Discussion not found' });

    const VALID_REASONS = ['spam', 'harassment', 'off_topic', 'inappropriate', 'other'];
    const { reason, details } = req.body;
    if (!reason || !VALID_REASONS.includes(String(reason))) {
      return res.status(400).json({ error: 'Valid reason is required (spam, harassment, off_topic, inappropriate, other)' });
    }

    const report = new DiscussionReport({
      user: req.user.id,
      discussion: discussion._id,
      reason: String(reason),
      details: details ? stripHtml(String(details)).slice(0, 1000) : undefined
    });

    await report.save();
    logAudit(req, 'discussion_report.create', { type: 'discussion_report', id: report._id });

    res.status(201).json({ message: 'Report submitted' });
  } catch (err) {
    console.error('Report discussion error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// POST /api/discussions/:discussionId/replies/:replyId/report - Report a reply
router.post('/:discussionId/replies/:replyId/report', requireAuth, requireNonDemo, async (req, res) => {
  try {
    if (!isValidId(req.params.replyId)) return res.status(400).json({ error: 'Invalid reply ID' });

    const reply = await DiscussionReply.findById(req.params.replyId);
    if (!reply) return res.status(404).json({ error: 'Reply not found' });

    const VALID_REASONS = ['spam', 'harassment', 'off_topic', 'inappropriate', 'other'];
    const { reason, details } = req.body;
    if (!reason || !VALID_REASONS.includes(String(reason))) {
      return res.status(400).json({ error: 'Valid reason is required (spam, harassment, off_topic, inappropriate, other)' });
    }

    const report = new DiscussionReport({
      user: req.user.id,
      reply: reply._id,
      reason: String(reason),
      details: details ? stripHtml(String(details)).slice(0, 1000) : undefined
    });

    await report.save();
    logAudit(req, 'discussion_report.create', { type: 'discussion_report', id: report._id });

    res.status(201).json({ message: 'Report submitted' });
  } catch (err) {
    console.error('Report reply error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

module.exports = router;
