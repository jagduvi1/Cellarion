/**
 * /api/forum-languages — which language sections the forum is open in, and the
 * ask-for-one queue.
 *
 * English is the forum's default and is not a row here (services/forumLanguages
 * explains why). Everything else is opened by a moderator, either from scratch
 * or by approving a member's request.
 */
const express = require('express');
const ForumLanguage = require('../models/ForumLanguage');
const Discussion = require('../models/Discussion');
const {
  DEFAULT_LANGUAGE, listActive, toPublic,
} = require('../services/forumLanguages');
const { requireAuth, requireNonDemo, optionalAuth, requireModeratorOrAdmin } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { stripHtml } = require('../utils/sanitize');

const router = express.Router();

const CODE_RE = /^[a-z]{2,3}(-[a-z]{2,4})?$/;

/**
 * GET /api/forum-languages — the sections a member can post in.
 * Anonymous-readable: the forum itself is, and the switcher renders for
 * logged-out readers too.
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    res.json({ languages: await listActive() });
  } catch (err) {
    console.error('List forum languages error:', err);
    res.status(500).json({ error: 'Failed to list forum languages' });
  }
});

/**
 * POST /api/forum-languages/requests — ask for a section.
 *
 * One pending request per code, shared by everyone who asks: a second member
 * asking for Portuguese joins the existing request rather than filing a
 * duplicate for a moderator to read twice.
 */
router.post('/requests', requireAuth, requireNonDemo, async (req, res) => {
  try {
    const rawCode = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase() : '';
    const name = stripHtml(typeof req.body?.name === 'string' ? req.body.name.trim() : '').slice(0, 60);
    const nativeName = stripHtml(typeof req.body?.nativeName === 'string' ? req.body.nativeName.trim() : '').slice(0, 60);
    const reason = stripHtml(typeof req.body?.reason === 'string' ? req.body.reason.trim() : '').slice(0, 500);

    if (!CODE_RE.test(rawCode)) {
      return res.status(400).json({ error: 'Language code must look like "fr" or "pt-br"' });
    }
    if (rawCode === DEFAULT_LANGUAGE) {
      return res.status(400).json({ error: 'English is already the forum default' });
    }
    if (!name) return res.status(400).json({ error: 'Language name is required' });

    const existing = await ForumLanguage.findOne({ code: rawCode }).select('status name').lean();
    if (existing) {
      const message = existing.status === 'active'
        ? `The ${existing.name} section is already open`
        : existing.status === 'requested'
          ? `${existing.name} has already been requested — a moderator will decide soon`
          : `The ${existing.name} section was closed; ask a moderator to reopen it`;
      return res.status(409).json({ error: message, status: existing.status });
    }

    const doc = await ForumLanguage.create({
      code: rawCode, name, nativeName: nativeName || null,
      status: 'requested', requestedBy: req.user.id, requestReason: reason || null,
    });
    logAudit(req, 'forum.language.request', { type: 'forumLanguage', id: doc._id },
      { code: doc.code, name: doc.name });

    res.status(201).json({ language: toPublic(doc) });
  } catch (err) {
    // The unique index is the real guard against two simultaneous requests.
    if (err.code === 11000) return res.status(409).json({ error: 'That language has already been requested' });
    console.error('Request forum language error:', err);
    res.status(500).json({ error: 'Failed to request forum language' });
  }
});

/**
 * GET /api/forum-languages/requests — the moderation queue (pending first).
 */
router.get('/requests', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const rows = await ForumLanguage.find({ status: { $in: ['requested', 'retired'] } })
      .populate('requestedBy', 'username displayName')
      .sort({ status: 1, createdAt: 1 })
      .lean();
    res.json({
      languages: rows.map(r => ({
        ...toPublic(r),
        _id: r._id,
        requestReason: r.requestReason || null,
        requestedBy: r.requestedBy
          ? { username: r.requestedBy.username, displayName: r.requestedBy.displayName }
          : null,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('List forum language requests error:', err);
    res.status(500).json({ error: 'Failed to list requests' });
  }
});

/**
 * POST /api/forum-languages — open a section directly (moderator).
 * Also the "reopen a retired section" path.
 */
router.post('/', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toLowerCase() : '';
    const name = stripHtml(typeof req.body?.name === 'string' ? req.body.name.trim() : '').slice(0, 60);
    const nativeName = stripHtml(typeof req.body?.nativeName === 'string' ? req.body.nativeName.trim() : '').slice(0, 60);

    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Language code must look like "fr" or "pt-br"' });
    if (code === DEFAULT_LANGUAGE) return res.status(400).json({ error: 'English is already the forum default' });
    if (!name) return res.status(400).json({ error: 'Language name is required' });

    const doc = await ForumLanguage.findOneAndUpdate(
      { code },
      {
        $set: { name, nativeName: nativeName || null, status: 'active', decidedBy: req.user.id, decidedAt: new Date() },
        $setOnInsert: { code },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    logAudit(req, 'forum.language.open', { type: 'forumLanguage', id: doc._id }, { code: doc.code, name: doc.name });
    res.status(201).json({ language: toPublic(doc) });
  } catch (err) {
    console.error('Open forum language error:', err);
    res.status(500).json({ error: 'Failed to open forum language' });
  }
});

/**
 * PATCH /api/forum-languages/:code — approve, reject or retire (moderator).
 *
 * `approve` opens a requested section · `reject` deletes the request (a
 * permanent "no" queue helps nobody, and the member can ask again) · `retire`
 * closes an open one WITHOUT touching its threads: they stay readable, and a
 * moderator can still move them out. The requester is notified either way —
 * they asked a question and deserve the answer.
 */
router.patch('/:code', requireAuth, requireModeratorOrAdmin, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toLowerCase();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Invalid language code' });
    if (code === DEFAULT_LANGUAGE) return res.status(400).json({ error: 'The English section cannot be changed' });

    const action = req.body?.action;
    if (!['approve', 'reject', 'retire'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve, reject or retire' });
    }

    const doc = await ForumLanguage.findOne({ code });
    if (!doc) return res.status(404).json({ error: 'No such forum language' });

    const requesterId = doc.requestedBy ? String(doc.requestedBy) : null;
    const note = stripHtml(typeof req.body?.note === 'string' ? req.body.note.trim() : '').slice(0, 300);

    if (action === 'reject') {
      await ForumLanguage.deleteOne({ _id: doc._id });
      logAudit(req, 'forum.language.reject', { type: 'forumLanguage', id: doc._id }, { code, name: doc.name, note });
      if (requesterId) {
        // Positional signature (userId, type, title, message, link) — and
        // fire-and-forget like every other notify call: a notification failure
        // must never undo a recorded decision.
        createNotification(
          requesterId,
          'forum_language_decided',
          'Forum language request declined',
          `We are not opening a ${doc.name} forum section for now.${note ? `\n\n${note}` : ''}`,
          '/community/discussions',
        );
      }
      return res.json({ code, status: 'rejected' });
    }

    doc.status = action === 'approve' ? 'active' : 'retired';
    doc.decidedBy = req.user.id;
    doc.decidedAt = new Date();
    await doc.save();

    logAudit(req, `forum.language.${action}`, { type: 'forumLanguage', id: doc._id }, { code, name: doc.name });

    if (action === 'approve' && requesterId) {
      createNotification(
        requesterId,
        'forum_language_decided',
        'Forum language opened',
        `The ${doc.name} forum section is open — you can pick it when starting a thread.${note ? `\n\n${note}` : ''}`,
        '/community/discussions',
      );
    }

    // Retiring hides a section from the pickers; say how much writing is still
    // in it so a moderator can decide whether to move it first.
    const threadCount = action === 'retire'
      ? await Discussion.countDocuments({ language: code })
      : undefined;

    res.json({ language: toPublic(doc), ...(threadCount !== undefined ? { threadCount } : {}) });
  } catch (err) {
    console.error('Decide forum language error:', err);
    res.status(500).json({ error: 'Failed to update forum language' });
  }
});

module.exports = router;
