const express = require('express');
const rateLimit = require('express-rate-limit');
const WineList = require('../models/WineList');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const { generateWineListPdf } = require('../services/wineListPdf');
const { getClientIp } = require('../utils/clientIp');

const router = express.Router();

// Rate limiter: 30 requests per 15 min per IP
const publicPdfLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

router.use(publicPdfLimiter);

/** Load and populate bottles for a wine list, returning a Map<bottleId, bottle>. */
async function loadBottleMap(wineList) {
  const bottleIds = new Set();
  if (wineList.structureMode === 'custom') {
    for (const section of wineList.sections || []) {
      for (const entry of section.entries || []) {
        bottleIds.add(entry.bottle.toString());
      }
    }
  } else {
    for (const entry of wineList.autoGroupEntries || []) {
      bottleIds.add(entry.bottle.toString());
    }
  }

  const bottles = await Bottle.find({ _id: { $in: [...bottleIds] } })
    .populate({
      path: 'wineDefinition',
      populate: [
        { path: 'country', select: 'name' },
        { path: 'region', select: 'name' },
        { path: 'grapes', select: 'name' },
      ],
      select: 'name producer type appellation country region grapes classification'
    })
    .lean();

  const map = new Map();
  for (const b of bottles) {
    map.set(b._id.toString(), b);
  }
  return map;
}

// GET /api/wine-lists/public/:shareToken/pdf — public PDF download
router.get('/:shareToken/pdf', async (req, res) => {
  try {
    const wineList = await WineList.findOne({
      shareToken: req.params.shareToken,
      isPublished: true,
    });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found or not published' });

    // Verify owner's plan still includes wineLists feature (downgrade protection)
    const bottleMap = await loadBottleMap(wineList);

    // Build the public URL for QR code (self-referencing)
    const base = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
    const publicUrl = `${base}/api/wine-lists/public/${req.params.shareToken}/pdf`;

    const pdfStream = await generateWineListPdf(wineList, bottleMap, { publicUrl });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(wineList.name || 'wine-list')}.pdf"`);
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    pdfStream.pipe(res);
  } catch (error) {
    console.error('Public PDF error:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

module.exports = router;
