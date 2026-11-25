const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const BlogPost = require('../models/BlogPost');
const { logAudit } = require('../services/audit');
const { submitUrls } = require('../services/indexNow');
const { LISTED, alternatesOf, resolveLanguageFields } = require('../services/blogLanguage');
const { isValidId, coerceStringQuery } = require('../utils/validation');
const { escapeRegex } = require('../utils/sanitize');
const { parsePagination } = require('../utils/pagination');
const asyncHandler = require('../utils/asyncHandler');
const { errorBody } = require('../config/errorCodes');

const router = express.Router();

// Bounded before it ever reaches a RegExp. A 10k-char needle cannot match a
// 200-char title, so the only thing an unbounded one buys is scan cost.
const MAX_SEARCH_LEN = 120;

// Letters a title in another language carries that NFD does not split into
// a base letter and an accent.
const FOLDED = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ð: 'd', þ: 'th', ł: 'l' };

/** The URL slug for a title: accents folded ("Déménager" → "demenager"), the rest dropped. */
function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßðþł]/g, (ch) => FOLDED[ch])
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

/**
 * A save the model refused is the client's mistake: 400 with the model's own
 * messages, or 409 when a second translation in one language lost a race to
 * the unique index. Answers and returns true for those; false for anything
 * else, which the caller rethrows to the central error handler.
 */
function refusedSave(err, res) {
  if (err.name === 'ValidationError') {
    res.status(400).json({ error: Object.values(err.errors).map((e) => e.message).join(', ') });
    return true;
  }
  if (err.code === 11000 && err.keyPattern && err.keyPattern.translationOf) {
    res.status(409).json(errorBody('blog_translation_exists'));
    return true;
  }
  return false;
}

// ── Public routes (no auth required) ──

// GET /api/blog — List published posts: the originals, the same for every
// reader; a translation is reached from its original (services/blogLanguage.js).
router.get('/', asyncHandler(async (req, res) => {
  const { limit, offset, page } = parsePagination(req.query, { limit: 12, maxLimit: 50 });

  const filter = { status: 'published', ...LISTED };
  if (typeof req.query.tag === 'string' && req.query.tag.trim()) {
    filter.tags = String(req.query.tag).toLowerCase();
  }

  // Free-text search. Deliberately a Mongo regex over title/excerpt/tags
  // rather than a Meilisearch index: the corpus is a few dozen posts, and
  // standing up a second search engine for that costs more to run and reason
  // about than it can possibly return. Revisit at a few hundred — the shape of
  // the endpoint does not change if the backing does.
  //
  // Why this exists at all with tag filtering already present: the posts carry
  // close to a hundred distinct tags, so the tag list reads as navigation, not
  // as a filter.
  //
  // escapeRegex + coerceStringQuery are load-bearing, not decoration:
  // `?q[$gt]=` arrives as an OBJECT, and an unescaped `(((((` is a ReDoS.
  const q = coerceStringQuery(req.query.q).trim().slice(0, MAX_SEARCH_LEN);
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    // Tags are stored lowercased; an exact tag hit is included so searching
    // "mcp" finds tagged posts whose prose never says the word.
    filter.$or = [{ title: rx }, { excerpt: rx }, { tags: q.toLowerCase() }];
  }

  const [posts, total] = await Promise.all([
    BlogPost.find(filter)
      .sort({ publishedAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('author', 'username')
      .select('-content'),
    BlogPost.countDocuments(filter)
  ]);

  res.json({ posts, total, page, pages: Math.ceil(total / limit) });
}));

// GET /api/blog/tags — Tags of the listed posts (the originals), most-used first
//
// Ordered by how many posts carry the tag rather than alphabetically. The blog
// page shows only the first handful before a "show all" toggle, and with many
// tags the alphabetical head ("3d", "ai", "analytics") is close to the least
// useful slice available. Ties break alphabetically so the order is
// stable. Response shape: an array of tag strings.
router.get('/tags', asyncHandler(async (req, res) => {
  const rows = await BlogPost.aggregate([
    { $match: { status: 'published', ...LISTED } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]);
  res.json({ tags: rows.map((row) => row._id) });
}));

// GET /api/blog/:slug — One published post by slug, original or translation,
// with every published version of it (`alternates`, [] when there is only
// this one) for the page's language links and hreflang.
router.get('/:slug', asyncHandler(async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' })
    .populate('author', 'username');
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post, alternates: await alternatesOf(post) });
}));

// ── Admin routes ──

// GET /api/blog/admin/posts — List all posts (including drafts)
router.get('/admin/posts', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { limit, offset, page } = parsePagination(req.query, { limit: 20, maxLimit: 50 });

  const filter = {};
  const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
  if (['draft', 'published'].includes(statusParam)) {
    filter.status = statusParam;
  }

  const [posts, total] = await Promise.all([
    BlogPost.find(filter)
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('author', 'username')
      .select('-content'),
    BlogPost.countDocuments(filter)
  ]);

  res.json({ posts, total, page, pages: Math.ceil(total / limit) });
}));

// GET /api/blog/admin/originals — Every post a translation can point at (the
// originals, drafts included), newest first: the editor's "Translation of" list.
router.get('/admin/originals', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const posts = await BlogPost.find(LISTED)
    .sort({ createdAt: -1 })
    .select('title slug language status')
    .lean();
  res.json({ posts: posts.map((p) => ({ ...p, language: p.language || 'en' })) });
}));

// GET /api/blog/admin/posts/:id — Get single post by ID (for editing)
router.get('/admin/posts/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });
  // The original a translation points at comes with its title, for the
  // editor's "Translation of" field.
  const post = await BlogPost.findById(req.params.id)
    .populate('author', 'username')
    .populate('translationOf', 'title slug language');
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json({ post });
}));

// POST /api/blog/admin/posts — Create a new post
router.post('/admin/posts', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { title, content, excerpt, coverImage, tags, status, metaTitle, metaDescription } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }

  const languageFields = await resolveLanguageFields(req.body, null);
  if (languageFields.fail) return res.status(languageFields.fail.status).json(languageFields.fail.body);

  let slug = generateSlug(title);
  // Ensure unique slug
  const existing = await BlogPost.findOne({ slug });
  if (existing) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  const postData = {
    title,
    slug,
    content,
    excerpt: excerpt || '',
    coverImage: coverImage || '',
    author: req.user.id,
    tags: Array.isArray(tags) ? tags.map(t => t.trim().toLowerCase()).filter(Boolean) : [],
    status: status || 'draft',
    metaTitle: metaTitle || '',
    metaDescription: metaDescription || '',
    language: languageFields.language,
    translationOf: languageFields.translationOf,
  };

  if (postData.status === 'published') {
    postData.publishedAt = new Date();
  }

  let post;
  try {
    post = await BlogPost.create(postData);
  } catch (err) {
    if (refusedSave(err, res)) return undefined;
    throw err;
  }
  await post.populate('author', 'username');

  logAudit(req, 'blog.create', { type: 'blogPost', id: post._id }, {
    title: post.title, status: post.status, language: post.language, translationOf: post.translationOf,
  });

  if (post.status === 'published') {
    submitUrls(`/blog/${post.slug}`);
  }

  return res.status(201).json({ post });
}));

// PUT /api/blog/admin/posts/:id — Update a post
router.put('/admin/posts/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });

  const post = await BlogPost.findById(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const languageFields = await resolveLanguageFields(req.body, post);
  if (languageFields.fail) return res.status(languageFields.fail.status).json(languageFields.fail.body);

  const { title, content, excerpt, coverImage, tags, status, metaTitle, metaDescription } = req.body;

  if (title !== undefined) post.title = title;
  if (content !== undefined) post.content = content;
  if (excerpt !== undefined) post.excerpt = excerpt;
  if (coverImage !== undefined) post.coverImage = coverImage;
  if (metaTitle !== undefined) post.metaTitle = metaTitle;
  if (metaDescription !== undefined) post.metaDescription = metaDescription;
  if (Array.isArray(tags)) {
    post.tags = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
  }
  post.language = languageFields.language;
  post.translationOf = languageFields.translationOf;

  // Handle publish transition
  if (status !== undefined) {
    if (status === 'published' && post.status !== 'published') {
      post.publishedAt = new Date();
    }
    post.status = status;
  }

  // The slug is pinned at creation and NEVER regenerated on title edits —
  // published URLs are indexed and backlinked, and changing the slug 404s
  // them with no redirect (Discussion pins its slug for the same reason).

  try {
    await post.save();
  } catch (err) {
    if (refusedSave(err, res)) return undefined;
    throw err;
  }
  await post.populate('author', 'username');

  logAudit(req, 'blog.update', { type: 'blogPost', id: post._id }, {
    title: post.title, status: post.status, language: post.language, translationOf: post.translationOf,
  });

  if (post.status === 'published') {
    submitUrls(`/blog/${post.slug}`);
  }

  return res.json({ post });
}));

// DELETE /api/blog/admin/posts/:id — Delete a post
router.delete('/admin/posts/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });

  const post = await BlogPost.findByIdAndDelete(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });

  // Its translations stay, as posts of their own in their language, rather
  // than pointing at an original that is gone.
  const detached = await BlogPost.updateMany({ translationOf: post._id }, { $set: { translationOf: null } });

  logAudit(req, 'blog.delete', { type: 'blogPost', id: post._id }, {
    title: post.title, translationsDetached: detached.modifiedCount || 0,
  });

  // Ping IndexNow so engines recrawl the dead URL and drop it, instead of
  // serving the stale entry until an organic recrawl (discussions do this).
  if (post.status === 'published') {
    submitUrls(`/blog/${post.slug}`);
  }

  return res.json({ message: 'Post deleted' });
}));

module.exports = router;
module.exports.generateSlug = generateSlug;
