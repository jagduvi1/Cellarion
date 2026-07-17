const express = require('express');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const JournalEntry = require('../models/JournalEntry');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('../services/audit');
// Entry sanitisation / ref validation / create / delete live in
// services/journalOps.js — ONE implementation shared with the MCP
// capture_tasting_note tool, so the two surfaces cannot drift.
const {
  sanitizeEntry, validatePairingRefs, createEntry, deleteEntry, OCCASIONS,
} = require('../services/journalOps');
const { escapeRegex } = require('../utils/sanitize');
const { isValidId } = require('../utils/validation');

const router = express.Router();
router.use(requireAuth);

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
// requireNonDemo: a public journal entry can tag real users, firing
// journal_mention notifications to them from an account that then vanishes —
// notification spam (same class the follows route guards against).
router.post('/', requireNonDemo, async (req, res) => {
  try {
    const result = await createEntry(req.user.id, req.body, req);
    if (result.error) return res.status(result.error.status).json({ error: result.error.message });

    const populated = await JournalEntry.findById(result.entry._id)
      .populate(POPULATE_PAIRINGS)
      .lean();

    res.status(201).json({ entry: redactPeople(populated, req.user.id) });
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

    const result = await deleteEntry(req.user.id, req.params.id, req);
    if (!result.deleted) return res.status(404).json({ error: 'Entry not found' });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete journal entry error:', err);
    res.status(500).json({ error: 'Failed to delete journal entry' });
  }
});

module.exports = router;
