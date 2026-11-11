// The admin routes of the label sweetness vocabulary (models/SweetnessTerm).
// Mounted by routes/admin/taxonomy.js, behind its admin gate and its
// cache-clearing middleware.

const express = require('express');
const { sanitizeTaxonomyName, normalizeSweetnessTerm } = require('../../utils/normalize');
const SweetnessTerm = require('../../models/SweetnessTerm');
const { invalidateSweetnessCache } = require('../../services/sweetnessOps');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { needsHumanReview, wineCountsBySweetnessTerm } = require('../../services/taxonomyUsage');

const router = express.Router();

// ─── Sweetness terms ────────────────────────────────────────────────────────
// The label sweetness vocabulary (models/SweetnessTerm):
// the same life cycle as classifications — list with wine counts and
// the review flag, create, edit, delete while unreferenced, approve. One rule
// of its own: the WORD of a term that wines carry is frozen. It is what their
// identity keys and slugs are built from (utils/normalize sweetnessKeySegment),
// so renaming it would move every one of their keys; a wrong word is a new
// row, and the wines move to it one by one through the ordinary write paths.

// GET /api/admin/taxonomy/sweetness-terms
router.get('/sweetness-terms', async (req, res) => {
  try {
    const [rows, counts] = await Promise.all([
      SweetnessTerm.find().sort({ scale: 1, name: 1 }).lean(),
      wineCountsBySweetnessTerm(),
    ]);
    const sweetnessTerms = rows.map((r) => {
      const wineCount = counts.get(String(r._id)) || 0;
      return { ...r, wineCount, needsReview: needsHumanReview(r, wineCount) };
    });
    res.json({
      sweetnessTerms,
      needsReviewCount: sweetnessTerms.filter((r) => r.needsReview).length,
      scales: SweetnessTerm.SCALES,
      bands: SweetnessTerm.BANDS,
    });
  } catch (error) {
    console.error('List sweetness terms error:', error);
    res.status(500).json({ error: 'Failed to list sweetness terms' });
  }
});

const cleanSweetnessTermBody = (body) => {
  const { name, scale, band, system, country, regulated, synonyms, description } = body || {};
  return {
    name: typeof name === 'string' ? sanitizeTaxonomyName(name) : '',
    scale,
    band,
    system: typeof system === 'string' && system.trim() ? system.trim().slice(0, 80) : null,
    country: country || null,
    regulated: regulated !== false,
    synonyms: Array.isArray(synonyms) ? synonyms.map((s) => String(s).trim()).filter(Boolean).slice(0, 30) : [],
    description: stripHtml(typeof description === 'string' ? description : ''),
  };
};
const scaleError = (scale) => (SweetnessTerm.SCALES.includes(scale) ? null : `scale must be one of: ${SweetnessTerm.SCALES.join(', ')}`);
const bandError = (scale, band) => ((SweetnessTerm.BANDS[scale] || []).includes(band) ? null : `band must be one of the ${scale} bands: ${(SweetnessTerm.BANDS[scale] || []).join(', ')}`);

// POST /api/admin/taxonomy/sweetness-terms — add a row; an admin's own row
// counts as reviewed, as a seeded one does.
router.post('/sweetness-terms', async (req, res) => {
  try {
    const fields = cleanSweetnessTermBody(req.body);
    if (!fields.name) return res.status(400).json({ error: 'Sweetness term is required' });
    const badScale = scaleError(fields.scale);
    if (badScale) return res.status(400).json({ error: badScale });
    const badBand = bandError(fields.scale, fields.band);
    if (badBand) return res.status(400).json({ error: badBand });
    if (fields.country && !isValidId(String(fields.country))) return res.status(400).json({ error: 'Invalid country' });
    const doc = new SweetnessTerm({
      ...fields,
      normalizedName: normalizeSweetnessTerm(fields.name),
      createdBy: req.user.id,
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
    });
    await doc.save();
    invalidateSweetnessCache();
    logAudit(req, 'admin.taxonomy.sweetness.create', { type: 'sweetnessTerm', id: doc._id }, { name: doc.name, scale: doc.scale, band: doc.band });
    res.status(201).json({ sweetnessTerm: doc });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ error: 'That term already exists on this scale' });
    console.error('Create sweetness term error:', error);
    res.status(500).json({ error: 'Failed to create sweetness term' });
  }
});

// PUT /api/admin/taxonomy/sweetness-terms/:id — edit a row. The word and the
// scale of a term that wines carry are frozen (see the section comment).
router.put('/sweetness-terms/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await SweetnessTerm.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Sweetness term not found' });
    const fields = cleanSweetnessTermBody(req.body);
    const before = { name: doc.name, scale: doc.scale, band: doc.band };
    const wordChanges = req.body.name !== undefined && normalizeSweetnessTerm(fields.name) !== doc.normalizedName;
    const scaleChanges = req.body.scale !== undefined && fields.scale !== doc.scale;
    if (wordChanges || scaleChanges) {
      const wineCount = await WineDefinition.countDocuments({ labelSweetness: { $eq: doc._id } });
      if (wineCount > 0) {
        return res.status(400).json({ error: `${wineCount} wine(s) carry this term: its word is part of their identity keys and its scale decides their band, so neither can change. Add the right term as a new row and move the wines to it.` });
      }
    }
    if (req.body.name !== undefined) {
      if (!fields.name) return res.status(400).json({ error: 'Sweetness term is required' });
      doc.name = fields.name;
      doc.normalizedName = normalizeSweetnessTerm(fields.name);
    }
    if (req.body.scale !== undefined) {
      const badScale = scaleError(fields.scale);
      if (badScale) return res.status(400).json({ error: badScale });
      // A band belongs to a scale: a scale change must bring a band of the
      // new scale in the same request, or the old band would fail validation.
      if (req.body.band === undefined && !(SweetnessTerm.BANDS[fields.scale] || []).includes(doc.band)) {
        return res.status(400).json({ error: `Changing the scale to ${fields.scale} needs a band of that scale in the same request: ${(SweetnessTerm.BANDS[fields.scale] || []).join(', ')}` });
      }
      doc.scale = fields.scale;
    }
    if (req.body.band !== undefined) {
      const badBand = bandError(doc.scale, fields.band);
      if (badBand) return res.status(400).json({ error: badBand });
      doc.band = fields.band;
    }
    if (req.body.system !== undefined) doc.system = fields.system;
    if (req.body.country !== undefined) {
      if (fields.country && !isValidId(String(fields.country))) return res.status(400).json({ error: 'Invalid country' });
      doc.country = fields.country;
    }
    if (req.body.regulated !== undefined) doc.regulated = fields.regulated;
    if (req.body.synonyms !== undefined) doc.synonyms = fields.synonyms;
    if (req.body.description !== undefined) doc.description = fields.description;
    await doc.save();
    invalidateSweetnessCache();
    logAudit(req, 'admin.taxonomy.sweetness.update', { type: 'sweetnessTerm', id: doc._id }, { from: before, to: { name: doc.name, scale: doc.scale, band: doc.band } });
    res.json({ sweetnessTerm: doc });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ error: 'That term already exists on this scale' });
    console.error('Update sweetness term error:', error);
    res.status(500).json({ error: 'Failed to update sweetness term' });
  }
});

// DELETE /api/admin/taxonomy/sweetness-terms/:id — only while no wine carries it.
router.delete('/sweetness-terms/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await SweetnessTerm.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Sweetness term not found' });
    const wineCount = await WineDefinition.countDocuments({ labelSweetness: { $eq: req.params.id } });
    if (wineCount > 0) {
      return res.status(400).json({ error: `Cannot delete sweetness term. ${wineCount} wine(s) carry it.` });
    }
    await SweetnessTerm.findByIdAndDelete(req.params.id);
    invalidateSweetnessCache();
    logAudit(req, 'admin.taxonomy.sweetness.delete', { type: 'sweetnessTerm', id: doc._id }, { name: doc.name, scale: doc.scale });
    res.json({ message: 'Sweetness term deleted' });
  } catch (error) {
    console.error('Delete sweetness term error:', error);
    res.status(500).json({ error: 'Failed to delete sweetness term' });
  }
});

// POST /api/admin/taxonomy/sweetness-terms/:id/approve — the review verb,
// idempotent and audited once, as for classifications.
router.post('/sweetness-terms/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await SweetnessTerm.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Sweetness term not found' });
    if (doc.reviewedAt) return res.json({ sweetnessTerm: doc, already: true });
    doc.reviewedAt = new Date();
    doc.reviewedBy = req.user.id;
    await doc.save();
    invalidateSweetnessCache();
    logAudit(req, 'admin.taxonomy.sweetness.approve', { type: 'sweetnessTerm', id: doc._id }, { name: doc.name, scale: doc.scale });
    res.json({ sweetnessTerm: doc });
  } catch (error) {
    console.error('Approve sweetness term error:', error);
    res.status(500).json({ error: 'Failed to approve sweetness term' });
  }
});

module.exports = router;
