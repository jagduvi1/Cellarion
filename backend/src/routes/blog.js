const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireRole } = require('../middleware/auth');
const BlogPost = require('../models/BlogPost');
const { logAudit } = require('../services/audit');

const router = express.Router();

const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100);
}

// ── Public routes (no auth required) ──

// GET /api/blog — List published posts
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const skip = (page - 1) * limit;

    const filter = { status: 'published' };
    if (typeof req.query.tag === 'string' && req.query.tag.trim()) {
      filter.tags = String(req.query.tag).toLowerCase();
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username')
        .select('-content'),
      BlogPost.countDocuments(filter)
    ]);

    res.json({ posts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[blog] list error:', err);
    res.status(500).json({ error: 'Failed to fetch blog posts' });
  }
});

// GET /api/blog/tags — List all tags from published posts
router.get('/tags', async (req, res) => {
  try {
    const tags = await BlogPost.distinct('tags', { status: 'published' });
    res.json({ tags: tags.sort() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// GET /api/blog/:slug — Get single published post by slug
router.get('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const post = await BlogPost.findOne({ slug, status: 'published' })
      .populate('author', 'username');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (err) {
    console.error('[blog] get post error:', err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// ── Admin routes ──

// GET /api/blog/admin/posts — List all posts (including drafts)
router.get('/admin/posts', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const filter = {};
    const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
    if (['draft', 'published'].includes(statusParam)) {
      filter.status = statusParam;
    }

    const [posts, total] = await Promise.all([
      BlogPost.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('author', 'username')
        .select('-content'),
      BlogPost.countDocuments(filter)
    ]);

    res.json({ posts, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('[blog] admin list error:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET /api/blog/admin/posts/:id — Get single post by ID (for editing)
router.get('/admin/posts/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });
    const post = await BlogPost.findById(req.params.id).populate('author', 'username');
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// POST /api/blog/admin/posts — Create a new post
router.post('/admin/posts', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { title, content, excerpt, coverImage, tags, status, metaTitle, metaDescription } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }

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
      metaDescription: metaDescription || ''
    };

    if (postData.status === 'published') {
      postData.publishedAt = new Date();
    }

    const post = await BlogPost.create(postData);
    await post.populate('author', 'username');

    logAudit(req, 'blog.create', { postId: post._id, title: post.title, status: post.status });

    res.status(201).json({ post });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('[blog] create error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// PUT /api/blog/admin/posts/:id — Update a post
router.put('/admin/posts/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });

    const post = await BlogPost.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const { title, content, excerpt, coverImage, tags, status, metaTitle, metaDescription } = req.body;

    const oldTitle = post.title;
    if (title !== undefined) post.title = title;
    if (content !== undefined) post.content = content;
    if (excerpt !== undefined) post.excerpt = excerpt;
    if (coverImage !== undefined) post.coverImage = coverImage;
    if (metaTitle !== undefined) post.metaTitle = metaTitle;
    if (metaDescription !== undefined) post.metaDescription = metaDescription;
    if (Array.isArray(tags)) {
      post.tags = tags.map(t => t.trim().toLowerCase()).filter(Boolean);
    }

    // Handle publish transition
    if (status !== undefined) {
      if (status === 'published' && post.status !== 'published') {
        post.publishedAt = new Date();
      }
      post.status = status;
    }

    // Regenerate slug if title changed
    if (title && title !== oldTitle) {
      let newSlug = generateSlug(title);
      const existing = await BlogPost.findOne({ slug: newSlug, _id: { $ne: post._id } });
      if (existing) newSlug = `${newSlug}-${Date.now().toString(36)}`;
      post.slug = newSlug;
    }

    await post.save();
    await post.populate('author', 'username');

    logAudit(req, 'blog.update', { postId: post._id, title: post.title, status: post.status });

    res.json({ post });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    console.error('[blog] update error:', err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// DELETE /api/blog/admin/posts/:id — Delete a post
router.delete('/admin/posts/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid post ID' });

    const post = await BlogPost.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    logAudit(req, 'blog.delete', { postId: post._id, title: post.title });

    res.json({ message: 'Post deleted' });
  } catch (err) {
    console.error('[blog] delete error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

module.exports = router;
