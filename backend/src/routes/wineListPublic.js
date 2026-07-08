const express = require('express');
const rateLimit = require('express-rate-limit');
const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const { generateWineListPdf, buildSections } = require('../services/wineListPdf');
const { loadWineMap } = require('../services/wineListData');
const { rateLimitKey } = require('../utils/clientIp');

const router = express.Router();

// Rate limiter: 120 requests per 15 min per IP. Generous on purpose — a full
// restaurant's guests often share one NAT'd IP, and each menu view is a
// single request (responses are also cached 5 min downstream).
const publicPdfLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

router.use(publicPdfLimiter);

// Wine lists survive their cellar's reversible soft-delete (restorable for
// 30 days), but the public menu must go dark for that window — a deleted
// cellar's list staying live would leak data the owner asked to remove.
async function cellarIsActive(wineList) {
  const cellar = await Cellar.findById(wineList.cellar).select('deletedAt').lean();
  return !!cellar && !cellar.deletedAt;
}

// GET /api/wine-lists/public/:shareToken — published list as JSON for the
// public web menu (/menu/:shareToken). Strips inventory data: guests see the
// menu, not the stock counts.
router.get('/:shareToken', async (req, res) => {
  try {
    const wineList = await WineList.findOne({
      shareToken: req.params.shareToken,
      isPublished: true,
    }).lean();
    if (!wineList) return res.status(404).json({ error: 'Wine list not found or not published' });
    if (!(await cellarIsActive(wineList))) return res.status(404).json({ error: 'Wine list not found or not published' });

    const wineMap = await loadWineMap(wineList);
    const sections = buildSections(wineList, wineMap).map(s => ({
      title: s.title,
      isGlassSection: !!s.isGlassSection,
      wines: s.wines.map(w => ({
        name: w.name,
        producer: w.producer,
        vintage: w.vintage,
        bottleSize: w.bottleSize,
        country: w.country,
        region: w.region,
        grapes: w.grapes,
        type: w.type,
        price: w.price,
        glassPrice: w.glassPrice,
      })),
    }));

    const branding = wineList.branding || {};
    const layout = wineList.layout || {};
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.json({
      name: wineList.name,
      language: wineList.language || 'en',
      branding: {
        restaurantName: branding.restaurantName || '',
        tagline: branding.tagline || '',
        logoUrl: branding.logoUrl || null,
        footerText: branding.footerText || '',
      },
      layout: {
        colorScheme: layout.colorScheme || 'classic',
        fontFamily: layout.fontFamily || 'serif',
        currencySymbol: layout.currencySymbol || '$',
      },
      sections,
    });
  } catch (error) {
    console.error('Public wine list error:', error);
    res.status(500).json({ error: 'Failed to load wine list' });
  }
});

// GET /api/wine-lists/public/:shareToken/pdf — public PDF download
router.get('/:shareToken/pdf', async (req, res) => {
  try {
    const wineList = await WineList.findOne({
      shareToken: req.params.shareToken,
      isPublished: true,
    });
    if (!wineList) return res.status(404).json({ error: 'Wine list not found or not published' });
    if (!(await cellarIsActive(wineList))) return res.status(404).json({ error: 'Wine list not found or not published' });

    const wineMap = await loadWineMap(wineList);

    // QR code on the printed PDF points at the web menu, which is what a
    // phone wants — the PDF itself stays one tap away from there. /menu is a
    // frontend route, so without FRONTEND_URL we cannot know a host that
    // serves it — fall back to the self-referencing PDF URL, which is valid
    // on whatever host handled this request.
    const publicUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/menu/${req.params.shareToken}`
      : `${req.protocol}://${req.get('host')}/api/wine-lists/public/${req.params.shareToken}/pdf`;

    const pdfStream = await generateWineListPdf(wineList, wineMap, { publicUrl });

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
