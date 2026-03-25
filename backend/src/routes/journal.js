const express = require('express');
const mongoose = require('mongoose');
const { requireAuth } = require('../middleware/auth');
const JournalEntry = require('../models/JournalEntry');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const User = require('../models/User');
const { stripHtml } = require('../utils/sanitize');

const router = express.Router();
router.use(requireAuth);

const isValidId = (id) => typeof id === 'string' && mongoose.isValidObjectId(id);
const MAX_PAIRINGS = 20;
const MAX_PEOPLE = 20;
const MAX_PHOTOS = 10;
const OCCASIONS = ['dinner', 'tasting', 'celebration', 'casual', 'gift', 'travel', 'other'];

function sanitizeEntry(body) {
  const {
    date, title, occasion, people, pairings, mood, notes, photos, visibility
  } = body;

  const clean = {};

  if (date) clean.date = new Date(date);
  if (title != null) clean.title = stripHtml(String(title)).slice(0, 200);
  if (occasion && OCCASIONS.includes(occasion)) clean.occasion = occasion;
  if (mood != null) {
    const m = parseInt(mood, 10);
    if (m >= 1 && m <= 5) clean.mood = m;
    else clean.mood = null;
  }
  if (notes != null) clean.notes = stripHtml(String(notes)).slice(0, 2000);
  if (visibility && ['private', 'public'].includes(visibility)) clean.visibility = visibility;

  if (Array.isArray(photos)) {
    clean.photos = photos.slice(0, MAX_PHOTOS).filter(p => typeof p === 'string');
  }

  if (Array.isArray(people)) {
    clean.people = people.slice(0, MAX_PEOPLE).map(p => ({
      name: stripHtml(String(p.name || '')).slice(0, 100),
      user: p.user && isValidId(p.user) ? p.user : null
    })).filter(p => p.name.length > 0);
  }

  if (Array.isArray(pairings)) {
    clean.pairings = pairings.slice(0, MAX_PAIRINGS).map(p => ({
      dish: stripHtml(String(p.dish || '')).slice(0, 200),
      bottle: p.bottle && isValidId(p.bottle) ? p.bottle : null,
      wine: p.wine && isValidId(p.wine) ? p.wine : null,
      wineName: stripHtml(String(p.wineName || '')).slice(0, 200),
      notes: stripHtml(String(p.notes || '')).slice(0, 500)
    }));
  }

  return clean;
}

// GET /api/journal/wine-search — search user's bottles + wine register for the pairing picker
router.get('/wine-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ bottles: [], wines: [] });

    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Search user's bottles (via wine definition name)
    const bottles = await Bottle.find({ user: req.user.id, status: 'active' })
      .populate({ path: 'wineDefinition', match: { $or: [{ name: regex }, { producer: regex }] }, select: 'name producer type' })
      .select('vintage wineDefinition')
      .lean();

    const matchedBottles = bottles
      .filter(b => b.wineDefinition)
      .slice(0, 10)
      .map(b => ({
        _id: b._id,
        vintage: b.vintage,
        wine: b.wineDefinition
      }));

    // Search wine register
    const wines = await WineDefinition.find({
      $or: [{ name: regex }, { producer: regex }]
    })
      .select('name producer type')
      .limit(10)
      .lean();

    res.json({ bottles: matchedBottles, wines });
  } catch (err) {
    console.error('Journal wine search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

const POPULATE_PAIRINGS = [
  { path: 'pairings.bottle', select: 'vintage wineDefinition', populate: { path: 'wineDefinition', select: 'name producer type' } },
  { path: 'pairings.wine', select: 'name producer type' },
  { path: 'people.user', select: 'username displayName' }
];

// GET /api/journal — list journal entries (own + public from following)
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const search = (req.query.q || '').trim();
    const occasion = req.query.occasion;

    const query = { user: new mongoose.Types.ObjectId(req.user.id) };

    if (occasion && OCCASIONS.includes(occasion)) {
      query.occasion = occasion;
    }

    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { title: regex },
        { notes: regex },
        { 'people.name': regex },
        { 'pairings.dish': regex },
        { 'pairings.wineName': regex },
        { 'pairings.notes': regex }
      ];
    }

    const [items, total] = await Promise.all([
      JournalEntry.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .populate(POPULATE_PAIRINGS)
        .lean(),
      JournalEntry.countDocuments(query)
    ]);

    res.json({ items, total, limit, skip });
  } catch (err) {
    console.error('Get journal entries error:', err);
    res.status(500).json({ error: 'Failed to load journal entries' });
  }
});

// GET /api/journal/:id — get a single entry
router.get('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const entry = await JournalEntry.findById(req.params.id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    // Only owner or public entries visible
    if (entry.user.toString() !== req.user.id && entry.visibility !== 'public') {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ entry });
  } catch (err) {
    console.error('Get journal entry error:', err);
    res.status(500).json({ error: 'Failed to load journal entry' });
  }
});

// POST /api/journal — create a new entry
router.post('/', async (req, res) => {
  try {
    const clean = sanitizeEntry(req.body);

    if (!clean.date || isNaN(clean.date.getTime())) {
      return res.status(400).json({ error: 'Valid date is required' });
    }

    const entry = await JournalEntry.create({
      user: req.user.id,
      ...clean
    });

    const populated = await JournalEntry.findById(entry._id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    // Notify tagged Cellarion users (if entry is public)
    if (populated.visibility === 'public' && populated.people?.length > 0) {
      const senderName = req.user.displayName || req.user.username || 'Someone';
      for (const person of populated.people) {
        if (person.user && person.user._id?.toString() !== req.user.id) {
          createNotification(
            person.user._id,
            'journal_mention',
            'Journal Mention',
            `${senderName} mentioned you in a journal entry: "${populated.title || 'Untitled'}"`,
            `/journal/${populated._id}`
          );
        }
      }
    }

    logAudit(req, 'journal.create', { type: 'journal', id: entry._id });

    res.status(201).json({ entry: populated });
  } catch (err) {
    console.error('Create journal entry error:', err);
    res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

// PUT /api/journal/:id — update an entry
router.put('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const entry = await JournalEntry.findOne({ _id: req.params.id, user: req.user.id });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const clean = sanitizeEntry(req.body);
    Object.assign(entry, clean);
    await entry.save();

    const populated = await JournalEntry.findById(entry._id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    logAudit(req, 'journal.update', { type: 'journal', id: entry._id });

    res.json({ entry: populated });
  } catch (err) {
    console.error('Update journal entry error:', err);
    res.status(500).json({ error: 'Failed to update journal entry' });
  }
});

// DELETE /api/journal/:id — delete an entry
router.delete('/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });

    const entry = await JournalEntry.findOneAndDelete({ _id: req.params.id, user: req.user.id });
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    logAudit(req, 'journal.delete', { type: 'journal', id: entry._id });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete journal entry error:', err);
    res.status(500).json({ error: 'Failed to delete journal entry' });
  }
});

module.exports = router;
