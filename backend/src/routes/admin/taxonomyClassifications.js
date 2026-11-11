// The admin routes of the classification taxonomy (models/Classification): the
// quality tiers a wine may carry. Mounted by routes/admin/taxonomy.js, behind
// its admin gate and its cache-clearing middleware.

const express = require('express');
const { normalizeString, sanitizeTaxonomyName } = require('../../utils/normalize');
const Classification = require('../../models/Classification');
const { invalidateClassificationCache } = require('../../services/classificationOps');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { stripHtml } = require('../../utils/sanitize');
const { needsHumanReview, wineCountsByClassification } = require('../../services/taxonomyUsage');

const router = express.Router();

// ── Classifications (models/Classification) ────────────────────────────────
// The quality tiers as a curated taxonomy with a kind each, managed here like
// grapes: list with wine counts and the review flag, create, edit, delete
// while unreferenced, and the explicit approve verb.

// GET /api/admin/taxonomy/classifications
router.get('/classifications', async (req, res) => {
  try {
    const [rows, counts] = await Promise.all([
      Classification.find().sort({ kind: 1, name: 1 }).lean(),
      wineCountsByClassification(),
    ]);
    const classifications = rows.map((c) => {
      const wineCount = counts.get(String(c._id)) || 0;
      return { ...c, wineCount, needsReview: needsHumanReview(c, wineCount) };
    });
    res.json({
      classifications,
      needsReviewCount: classifications.filter((c) => c.needsReview).length,
      kinds: Classification.KINDS,
    });
  } catch (error) {
    console.error('List classifications error:', error);
    res.status(500).json({ error: 'Failed to list classifications' });
  }
});

const cleanClassificationBody = (body) => {
  const { name, kind, system, country, synonyms, description } = body || {};
  return {
    name: typeof name === 'string' ? sanitizeTaxonomyName(name) : '',
    kind,
    system: typeof system === 'string' && system.trim() ? system.trim().slice(0, 80) : null,
    country: country || null,
    synonyms: Array.isArray(synonyms) ? synonyms.map((s) => String(s).trim()).filter(Boolean).slice(0, 30) : [],
    description: stripHtml(typeof description === 'string' ? description : ''),
  };
};

// POST /api/admin/taxonomy/classifications — add a row; an admin's own row
// counts as reviewed, as a seeded one does.
router.post('/classifications', async (req, res) => {
  try {
    const fields = cleanClassificationBody(req.body);
    if (!fields.name) return res.status(400).json({ error: 'Classification name is required' });
    if (!Classification.KINDS.includes(fields.kind)) {
      return res.status(400).json({ error: `kind must be one of: ${Classification.KINDS.join(', ')}` });
    }
    if (fields.country && !isValidId(String(fields.country))) return res.status(400).json({ error: 'Invalid country' });
    const doc = new Classification({
      ...fields,
      normalizedName: normalizeString(fields.name),
      createdBy: req.user.id,
      reviewedAt: new Date(),
      reviewedBy: req.user.id,
    });
    await doc.save();
    invalidateClassificationCache();
    logAudit(req, 'admin.taxonomy.create', { type: 'classification', id: doc._id }, { name: doc.name, kind: doc.kind });
    res.status(201).json({ classification: doc });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ error: 'Classification already exists' });
    console.error('Create classification error:', error);
    res.status(500).json({ error: 'Failed to create classification' });
  }
});

// PUT /api/admin/taxonomy/classifications/:id — edit a row. A renamed row
// rewrites the derived string on every wine that carries it.
router.put('/classifications/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await Classification.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Classification not found' });
    const fields = cleanClassificationBody(req.body);
    const before = { name: doc.name, kind: doc.kind };
    if (req.body.name !== undefined) {
      if (!fields.name) return res.status(400).json({ error: 'Classification name is required' });
      doc.name = fields.name;
      doc.normalizedName = normalizeString(fields.name);
    }
    if (req.body.kind !== undefined) {
      if (!Classification.KINDS.includes(fields.kind)) {
        return res.status(400).json({ error: `kind must be one of: ${Classification.KINDS.join(', ')}` });
      }
      doc.kind = fields.kind;
    }
    if (req.body.system !== undefined) doc.system = fields.system;
    if (req.body.country !== undefined) {
      if (fields.country && !isValidId(String(fields.country))) return res.status(400).json({ error: 'Invalid country' });
      doc.country = fields.country;
    }
    if (req.body.synonyms !== undefined) doc.synonyms = fields.synonyms;
    if (req.body.description !== undefined) doc.description = fields.description;
    await doc.save();
    let rewritten = 0;
    if (before.name !== doc.name || before.kind !== doc.kind) {
      const { classificationString } = require('../../services/classificationOps');
      const wines = await WineDefinition.find({ classifications: doc._id }).select('classifications').lean();
      for (const w of wines) {
        const rows = await Classification.find({ _id: { $in: w.classifications } }).select('name kind').lean();
        await WineDefinition.updateOne({ _id: w._id }, { $set: { classification: classificationString(rows), updatedAt: new Date() } });
        rewritten += 1;
      }
    }
    invalidateClassificationCache();
    logAudit(req, 'admin.taxonomy.update', { type: 'classification', id: doc._id }, { from: before, to: { name: doc.name, kind: doc.kind }, winesRewritten: rewritten });
    res.json({ classification: doc, winesRewritten: rewritten });
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ error: 'Classification already exists' });
    console.error('Update classification error:', error);
    res.status(500).json({ error: 'Failed to update classification' });
  }
});

// DELETE /api/admin/taxonomy/classifications/:id — only while no wine carries it.
router.delete('/classifications/:id', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await Classification.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Classification not found' });
    const wineCount = await WineDefinition.countDocuments({ classifications: req.params.id });
    if (wineCount > 0) {
      return res.status(400).json({ error: `Cannot delete classification. ${wineCount} wine(s) carry it.` });
    }
    await Classification.findByIdAndDelete(req.params.id);
    invalidateClassificationCache();
    logAudit(req, 'admin.taxonomy.delete', { type: 'classification', id: doc._id }, { name: doc.name, kind: doc.kind });
    res.json({ message: 'Classification deleted' });
  } catch (error) {
    console.error('Delete classification error:', error);
    res.status(500).json({ error: 'Failed to delete classification' });
  }
});

// POST /api/admin/taxonomy/classifications/:id/approve — the review verb,
// idempotent and audited once, as for regions and grapes.
router.post('/classifications/:id/approve', async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const doc = await Classification.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Classification not found' });
    if (doc.reviewedAt) return res.json({ classification: doc, already: true });
    doc.reviewedAt = new Date();
    doc.reviewedBy = req.user.id;
    await doc.save();
    invalidateClassificationCache();
    logAudit(req, 'admin.taxonomy.approveClassification', { type: 'classification', id: doc._id }, { name: doc.name });
    res.json({ classification: doc });
  } catch (error) {
    console.error('Approve classification error:', error);
    res.status(500).json({ error: 'Failed to approve classification' });
  }
});

module.exports = router;
