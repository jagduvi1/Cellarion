const express = require('express');
const rateLimit = require('express-rate-limit');
const BlogPost = require('../models/BlogPost');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { getClientIp } = require('../utils/clientIp');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3;

const router = express.Router();

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';

const sitemapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false
});

// GET /sitemap.xml — Dynamic XML sitemap for search engines
router.get('/', sitemapLimiter, async (req, res) => {
  try {
    const posts = await BlogPost.find({ status: 'published' })
      .sort({ publishedAt: -1 })
      .select('slug updatedAt publishedAt')
      .lean();

    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'weekly' },
      { loc: '/blog', priority: '0.8', changefreq: 'daily' },
      { loc: '/help', priority: '0.6', changefreq: 'monthly' },
      { loc: '/privacy', priority: '0.3', changefreq: 'yearly' },
    ];

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    for (const page of staticPages) {
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}${page.loc}</loc>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += '  </url>\n';
    }

    for (const post of posts) {
      const lastmod = (post.updatedAt || post.publishedAt).toISOString().split('T')[0];
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/blog/${post.slug}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.7</priority>\n';
      xml += '  </url>\n';
    }

    // Wine pages — public wine detail pages. Prefer slug URLs when available
    // (human-readable, AI-citable); fall back to ObjectId for any wine that
    // hasn't been migrated yet so the sitemap stays complete.
    const wines = await WineDefinition.find()
      .sort({ updatedAt: -1 })
      .select('_id slug updatedAt')
      .limit(5000)
      .lean();

    for (const wine of wines) {
      const lastmod = (wine.updatedAt || wine._id.getTimestamp()).toISOString().split('T')[0];
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/wines/${wine.slug || wine._id}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.5</priority>\n';
      xml += '  </url>\n';
    }

    // Taxonomy pages — only include entries that meet the minimum wine threshold
    // so we don't submit empty pages to search engines.

    const [countries, regions, grapes] = await Promise.all([
      Country.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
      Region.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
      Grape.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean()
    ]);

    for (const c of countries) {
      const count = await WineDefinition.countDocuments({ country: c._id });
      if (count < MIN_WINES) continue;
      const lastmod = c.updatedAt ? c.updatedAt.toISOString().split('T')[0] : '';
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/countries/${c.slug}</loc>\n`;
      if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.6</priority>\n';
      xml += '  </url>\n';
    }

    for (const r of regions) {
      const count = await WineDefinition.countDocuments({ region: r._id });
      if (count < MIN_WINES) continue;
      const lastmod = r.updatedAt ? r.updatedAt.toISOString().split('T')[0] : '';
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/regions/${r.slug}</loc>\n`;
      if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.6</priority>\n';
      xml += '  </url>\n';
    }

    for (const g of grapes) {
      const count = await WineDefinition.countDocuments({ grapes: g._id });
      if (count < MIN_WINES) continue;
      const lastmod = g.updatedAt ? g.updatedAt.toISOString().split('T')[0] : '';
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/grapes/${g.slug}</loc>\n`;
      if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.6</priority>\n';
      xml += '  </url>\n';
    }

    for (const type of WINE_TYPES) {
      const count = await WineDefinition.countDocuments({ type });
      if (count < MIN_WINES) continue;
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/wines/type/${type}</loc>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.5</priority>\n';
      xml += '  </url>\n';
    }

    xml += '</urlset>';

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) {
    console.error('[sitemap] generation error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Sitemap generation failed');
  }
});

module.exports = router;
