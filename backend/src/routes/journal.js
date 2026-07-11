const express = require('express');
const { requireAuth } = require('../middleware/auth');
const JournalEntry = require('../models/JournalEntry');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { stripHtml, escapeRegex } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');
const { getCellarRole } = require('../utils/cellarAccess');

const router = express.Router();
router.use(requireAuth);
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
    if (Number.isInteger(m) && m >= 1 && m <= 5) clean.mood = m;
    else {
      // Reject instead of silently nulling — a PUT with mood: 7 used to
      // erase the stored value without any indication.
      const err = new Error('Mood must be a whole number between 1 and 5');
      err.status = 400;
      throw err;
    }
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

/**
 * Ownership/existence validation for the references sanitizeEntry accepted by
 * shape alone (audit L-5). Mirrors sanitizeEntry's style: invalid references
 * are silently dropped (nulled), never a hard 400 — exactly like a malformed
 * ObjectId already is.
 *
 *  - pairings[].bottle must resolve to a bottle the author can access: their
 *    own bottle, or one in a cellar where they hold any role (getCellarRole,
 *    same check the bottles routes use). Otherwise a foreign bottle id would
 *    be populated back as {vintage, wine name/producer/type}.
 *  - pairings[].wine is a public WineDefinition ref → existence check only.
 */
async function validatePairingRefs(clean, userId) {
  if (!Array.isArray(clean.pairings) || clean.pairings.length === 0) return;

  const bottleIds = [...new Set(clean.pairings.filter(p => p.bottle).map(p => String(p.bottle)))];
  if (bottleIds.length) {
    const bottles = await Bottle.find({ _id: { $in: bottleIds } })
      .select('user cellar')
      .populate('cellar', 'user members deletedAt')
      .lean();
    const accessible = new Set(
      bottles
        .filter(b =>
          String(b.user) === String(userId) ||
          (b.cellar && !b.cellar.deletedAt && getCellarRole(b.cellar, userId))
        )
        .map(b => String(b._id))
    );
    for (const p of clean.pairings) {
      if (p.bottle && !accessible.has(String(p.bottle))) p.bottle = null;
    }
  }

  const wineIds = [...new Set(clean.pairings.filter(p => p.wine).map(p => String(p.wine)))];
  if (wineIds.length) {
    const wines = await WineDefinition.find({ _id: { $in: wineIds } }).select('_id').lean();
    const existing = new Set(wines.map(w => String(w._id)));
    for (const p of clean.pairings) {
      if (p.wine && !existing.has(String(p.wine))) p.wine = null;
    }
  }
}

/**
 * Read-time privacy gate for populated people[].user (audit L-5). A private
 * profile's username/displayName must not be resolvable by tagging its
 * ObjectId in a journal entry — that would re-open the enumeration oracle
 * users.js GET /public/:userId closes. Private users (other than the
 * requester themselves) are reduced to their bare _id; the helper also strips
 * the profileVisibility field the populate fetched for this decision.
 * Applied at read time so rows written before this gate are covered too.
 */
function redactPeople(entry, requesterId) {
  if (!entry || !Array.isArray(entry.people)) return entry;
  entry.people = entry.people.map(p => {
    const u = p.user;
    if (!u || typeof u !== 'object' || !u._id) return p;
    if (u.profileVisibility === 'private' && String(u._id) !== String(requesterId)) {
      return { ...p, user: { _id: u._id } };
    }
    const { profileVisibility, ...visible } = u;
    return { ...p, user: visible };
  });
  return entry;
}

// GET /api/journal/wine-search — search user's bottles + wine register for the pairing picker
router.get('/wine-search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ bottles: [], wines: [] });

    const regex = new RegExp(escapeRegex(q), 'i');

    // Resolve matching wine definitions first, then fetch only the user's
    // bottles for those wines (capped). Avoids the previous pattern of loading
    // the user's ENTIRE active-bottle collection into memory on every keystroke
    // just to filter it down to 10.
    const matchedWines = await WineDefinition.find({ $or: [{ name: regex }, { producer: regex }] })
      .select('name producer type')
      .limit(200)
      .lean();
    const matchedWineIds = matchedWines.map(w => w._id);

    const bottles = matchedWineIds.length
      ? await Bottle.find({ user: req.user.id, status: 'active', wineDefinition: { $in: matchedWineIds } })
          .populate({ path: 'wineDefinition', select: 'name producer type' })
          .select('vintage wineDefinition')
          .limit(10)
          .lean()
      : [];

    const matchedBottles = bottles
      .filter(b => b.wineDefinition)
      .map(b => ({
        _id: b._id,
        vintage: b.vintage,
        wine: b.wineDefinition
      }));

    // Wine register results (already capped)
    const wines = matchedWines.slice(0, 10);

    res.json({ bottles: matchedBottles, wines });
  } catch (err) {
    console.error('Journal wine search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

const POPULATE_PAIRINGS = [
  { path: 'pairings.bottle', select: 'vintage wineDefinition', populate: { path: 'wineDefinition', select: 'name producer type' } },
  { path: 'pairings.wine', select: 'name producer type' },
  // profileVisibility is fetched ONLY for redactPeople's gate — it is
  // stripped from every response before send.
  { path: 'people.user', select: 'username displayName profileVisibility' }
];

// GET /api/journal — list the user's own journal entries
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const search = String(req.query.q || '').trim();
    const occasion = req.query.occasion;

    if (!isValidId(req.user.id)) return res.status(401).json({ error: 'Invalid user' });
    const query = { user: req.user.id };

    if (occasion && OCCASIONS.includes(occasion)) {
      query.occasion = occasion;
    }

    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
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

    res.json({ items: items.map(i => redactPeople(i, req.user.id)), total, limit, skip });
  } catch (err) {
    console.error('Get journal entries error:', err);
    res.status(500).json({ error: 'Failed to load journal entries' });
  }
});

// POST /api/journal — create a new entry
router.post('/', async (req, res) => {
  try {
    const clean = sanitizeEntry(req.body);

    if (!clean.date || isNaN(clean.date.getTime())) {
      return res.status(400).json({ error: 'Valid date is required' });
    }

    await validatePairingRefs(clean, req.user.id);

    const entry = await JournalEntry.create({
      user: req.user.id,
      ...clean
    });

    const populated = await JournalEntry.findById(entry._id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    // Notify tagged Cellarion users (if entry is public). req.user only
    // carries JWT claims (id/roles/plan) — the name must come from the DB.
    if (populated.visibility === 'public' && populated.people?.length > 0) {
      const sender = await User.findById(req.user.id).select('username displayName').lean();
      const senderName = sender?.displayName || sender?.username || 'Someone';
      for (const person of populated.people) {
        if (person.user && person.user._id?.toString() !== req.user.id) {
          createNotification(
            person.user._id,
            'journal_mention',
            'Journal Mention',
            `${senderName} mentioned you in a journal entry: "${populated.title || 'Untitled'}"`,
            `/journal/${populated._id}`,
            undefined,
            req.user.id // actor — lets GDPR erasure remove this on the mentioner's deletion
          );
        }
      }
    }

    logAudit(req, 'journal.create', { type: 'journal', id: entry._id });

    res.status(201).json({ entry: redactPeople(populated, req.user.id) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
    await validatePairingRefs(clean, req.user.id);
    Object.assign(entry, clean);
    await entry.save();

    const populated = await JournalEntry.findById(entry._id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    logAudit(req, 'journal.update', { type: 'journal', id: entry._id });

    res.json({ entry: redactPeople(populated, req.user.id) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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
