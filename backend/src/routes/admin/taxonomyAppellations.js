// The admin routes of the appellations: the curated list (models/Appellation)
// and the review queue of the free-text appellations on wines that no curated
// entry covers. Mounted by routes/admin/taxonomy.js, behind its admin gate and
// its cache-clearing middleware.

const express = require('express');
const mongoose = require('mongoose');
const { normalizeAppellationKey } = require('../../utils/normalize');
const Appellation = require('../../models/Appellation');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const {
  listUnmatchedAppellations, appellationRefsError, dismissUnmatchedAppellation,
  restoreDismissedAppellation, listDismissedAppellations,
} = require('../../services/taxonomyReview');
const { wineCountsByAppellation } = require('../../services/taxonomyUsage');

const router = express.Router();

// ===== APPELLATIONS =====

// Input validation for the two write routes below, mirroring the MCP
// promote_appellation schema byte-for-byte (name ≤200; synonyms at most 10
// strings of ≤200 chars) so the two curation surfaces cannot drift. The
// element type and the array length are both checked: normalizedSynonyms is
// an INDEXED multikey field, so an unbounded array would grow the index, and
// a non-string element would fail the Mongoose cast into a 500.
const APPELLATION_NAME_MAX = 200;
const APPELLATION_SYNONYMS_MAX = 10;

/**
 * typeof, not truthiness: a JSON body value
 * like {"$ne":null} is truthy, and the .trim() below would throw a TypeError
 * that the route's catch turns into a 500. Nothing is exploitable — it throws
 * before any Mongo query — but the answer should be a 400.
 *
 * @returns {string|null} the error message, or null when the name is valid.
 */
function appellationNameError(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Appellation name is required';
  // The mint chokepoint caps wine fields at 200; a longer curated name would be
  // adopted onto wines past that cap.
  if (name.trim().length > APPELLATION_NAME_MAX) {
    return `Appellation name must be ${APPELLATION_NAME_MAX} characters or fewer`;
  }
  return null;
}

/**
 * @returns {{error: string}|{value: string[]|undefined}} trimmed, de-duplicated
 *   synonyms — `undefined` rather than [] when nothing survives, matching the
 *   schema's `default: undefined` so an empty list leaves no array behind for
 *   the normalizedSynonyms lookup to scan.
 */
function validateAppellationSynonyms(synonyms) {
  if (!Array.isArray(synonyms)) return { error: 'synonyms must be an array of strings' };
  if (synonyms.length > APPELLATION_SYNONYMS_MAX) {
    return { error: `At most ${APPELLATION_SYNONYMS_MAX} synonyms per appellation` };
  }
  const out = [];
  const seen = new Set();
  for (const raw of synonyms) {
    if (typeof raw !== 'string') return { error: 'synonyms must be an array of strings' };
    const value = raw.trim().replace(/\s+/g, ' ');
    if (!value) continue;
    if (value.length > APPELLATION_NAME_MAX) {
      return { error: `Each synonym must be ${APPELLATION_NAME_MAX} characters or fewer` };
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue; // an admin pasting a list shouldn't create dupes
    seen.add(key);
    out.push(value);
  }
  return { value: out.length ? out : undefined };
}

// GET /api/admin/taxonomy/appellations/unmatched — the appellation review
// queue. Wines store appellations as free text; this
// lists every distinct normalized string that NO curated Appellation doc (by
// name or synonym) covers, with the majority display spelling and the
// majority country/region so the admin can promote it in one click (the
// existing create endpoint) or fix the wines. Unknown values are reviewed,
// never rejected — adding a bottle must not be blocked by taxonomy.
router.get('/appellations/unmatched', async (req, res) => {
  try {
    const items = await listUnmatchedAppellations();
    res.json({ total: items.length, items });
  } catch (error) {
    console.error('Unmatched appellations error:', error);
    res.status(500).json({ error: 'Failed to list unmatched appellations' });
  }
});

// POST /api/admin/taxonomy/appellations/unmatched/dismiss — reviewed and
// judged NOT promotable (a quality tier, a fantasy name, a label slogan).
// Persists a skip so the live aggregate stops resurfacing the string
// (the same terminal state the price queue has with declines).
// The audit target carries no ObjectId (the subject is a string key, and
// target.id is typed ObjectId) — key and name ride in the details.
router.post('/appellations/unmatched/dismiss', async (req, res) => {
  try {
    const result = await dismissUnmatchedAppellation({
      name: req.body?.name, reason: req.body?.reason, userId: req.user.id,
    });
    if (result.error) return res.status(400).json({ error: result.error });
    logAudit(req, 'admin.taxonomy.appellationDismiss', { type: 'appellation' },
      { key: result.key, name: result.name, reason: req.body?.reason, already: !result.created });
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    console.error('Dismiss unmatched appellation error:', error);
    res.status(500).json({ error: 'Failed to dismiss appellation' });
  }
});

// GET /api/admin/taxonomy/appellations/dismissed — the restorable record of
// what was reviewed and rejected, newest first.
router.get('/appellations/dismissed', async (req, res) => {
  try {
    const items = await listDismissedAppellations();
    res.json({ total: items.length, items });
  } catch (error) {
    console.error('Dismissed appellations error:', error);
    res.status(500).json({ error: 'Failed to list dismissed appellations' });
  }
});

// POST /api/admin/taxonomy/appellations/dismissed/restore — lift a dismissal;
// the string re-enters the unmatched queue while wines still carry it.
router.post('/appellations/dismissed/restore', async (req, res) => {
  try {
    const result = await restoreDismissedAppellation(req.body?.name);
    if (result.error) return res.status(400).json({ error: result.error });
    if (!result.restored) return res.status(404).json({ error: 'No dismissal recorded for that string' });
    logAudit(req, 'admin.taxonomy.appellationRestore', { type: 'appellation' }, { key: result.key });
    res.json(result);
  } catch (error) {
    console.error('Restore dismissed appellation error:', error);
    res.status(500).json({ error: 'Failed to restore appellation' });
  }
});

// GET /api/admin/taxonomy/appellations - List (filter by country and/or region)
router.get('/appellations', async (req, res) => {
  try {
    const { country, region } = req.query;
    const filter = {};
    if (country) {
      if (!mongoose.Types.ObjectId.isValid(country)) {
        return res.status(400).json({ error: 'Invalid country id' });
      }
      filter.country = country;
    }
    if (region) {
      if (!mongoose.Types.ObjectId.isValid(region)) {
        return res.status(400).json({ error: 'Invalid region id' });
      }
      filter.region = region;
    }

    const [appellations, wineCounts] = await Promise.all([
      Appellation.find(filter)
        .populate('country', 'name')
        .populate('region', 'name')
        .sort({ name: 1 })
        .lean(),
      wineCountsByAppellation(),
    ]);
    // Free-text join: wines carry the appellation as a string, so a doc's
    // usage is every wine whose normalized string matches its normalizedName.
    const rows = appellations.map(a => ({
      ...a,
      wineCount: wineCounts.get(a.normalizedName || normalizeAppellationKey(a.name || '')) || 0,
    }));

    res.json({ count: rows.length, appellations: rows });
  } catch (error) {
    console.error('Get appellations error:', error);
    res.status(500).json({ error: 'Failed to get appellations' });
  }
});

// POST /api/admin/taxonomy/appellations - Create appellation
router.post('/appellations', async (req, res) => {
  try {
    const { name, country, region, synonyms } = req.body;

    const nameError = appellationNameError(name);
    if (nameError) return res.status(400).json({ error: nameError });
    if (!country) {
      return res.status(400).json({ error: 'Country is required' });
    }
    // Both refs verified: the ids must exist and the region must belong to the
    // country — the schema declares the refs but
    // enforces neither, so a cross-country region would sit silently wrong in
    // curated taxonomy until the appellation-hierarchy work inherited it.
    const refsError = await appellationRefsError(country, region);
    if (refsError) return res.status(400).json({ error: refsError });

    let cleanSynonyms;
    if (synonyms !== undefined && synonyms !== null) {
      const checked = validateAppellationSynonyms(synonyms);
      if (checked.error) return res.status(400).json({ error: checked.error });
      cleanSynonyms = checked.value;
    }

    const normalizedName = normalizeAppellationKey(name);

    const appellation = new Appellation({
      name: name.trim(),
      normalizedName,
      country,
      region: region || null,
      synonyms: cleanSynonyms,
      createdBy: req.user.id
    });

    await appellation.save();
    await appellation.populate('country', 'name');
    await appellation.populate('region', 'name');

    logAudit(req, 'admin.taxonomy.create',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );
    res.status(201).json({ appellation });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Appellation already exists in this country' });
    }
    console.error('Create appellation error:', error);
    res.status(500).json({ error: 'Failed to create appellation' });
  }
});

// PUT /api/admin/taxonomy/appellations/:id - Update appellation
router.put('/appellations/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { name, region, synonyms } = req.body;

    const appellation = await Appellation.findById(req.params.id);
    if (!appellation) {
      return res.status(404).json({ error: 'Appellation not found' });
    }

    // An absent name leaves it alone (partial update); a PRESENT one is
    // validated, so a non-string can no longer reach .trim().
    if (name !== undefined && name !== null) {
      const nameError = appellationNameError(name);
      if (nameError) return res.status(400).json({ error: nameError });
      appellation.name = name.trim();
      appellation.normalizedName = normalizeAppellationKey(name);
    }
    if (region !== undefined) {
      // Clearing (null/'') is always fine; SETTING a region re-validates it
      // against the appellation's country — update was the easiest drift path,
      // since a correctly created doc could be re-pointed at any region.
      if (region) {
        const refsError = await appellationRefsError(appellation.country, region);
        if (refsError) return res.status(400).json({ error: refsError });
      }
      appellation.region = region || null;
    }
    if (synonyms !== undefined) {
      // null clears the list, matching how the rest of the admin surface
      // distinguishes "leave alone" (absent) from "clear" (explicit null).
      if (synonyms === null) {
        appellation.synonyms = undefined;
      } else {
        const checked = validateAppellationSynonyms(synonyms);
        if (checked.error) return res.status(400).json({ error: checked.error });
        appellation.synonyms = checked.value;
      }
    }

    await appellation.save();
    await appellation.populate('country', 'name');
    await appellation.populate('region', 'name');
    logAudit(req, 'admin.taxonomy.update',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );

    res.json({ appellation });
  } catch (error) {
    console.error('Update appellation error:', error);
    res.status(500).json({ error: 'Failed to update appellation' });
  }
});

// DELETE /api/admin/taxonomy/appellations/:id - Delete appellation
router.delete('/appellations/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const appellation = await Appellation.findById(req.params.id);
    if (!appellation) {
      return res.status(404).json({ error: 'Appellation not found' });
    }

    logAudit(req, 'admin.taxonomy.delete',
      { type: 'appellation', id: appellation._id },
      { name: appellation.name }
    );
    await appellation.deleteOne();
    res.json({ message: 'Appellation deleted successfully' });
  } catch (error) {
    console.error('Delete appellation error:', error);
    res.status(500).json({ error: 'Failed to delete appellation' });
  }
});

module.exports = router;
// The input validators are exported for their unit tests: they are pure and
// DB-free, and they are the half of the REST/MCP parity contract that lives on
// this side.
module.exports.appellationNameError = appellationNameError;
module.exports.validateAppellationSynonyms = validateAppellationSynonyms;
