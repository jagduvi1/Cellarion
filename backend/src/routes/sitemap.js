const express = require('express');
const rateLimit = require('express-rate-limit');
const BlogPost = require('../models/BlogPost');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Discussion = require('../models/Discussion');
const { rateLimitKey } = require('../utils/clientIp');
const { countWinesBy } = require('./taxonomy');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3;

const router = express.Router();

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';

// Server-side cache: crawlers ignore Cache-Control per-client, and building
// the sitemap runs several registry-wide aggregations. Content changes slowly
// (new wines/posts), so an hour-stale sitemap is fine.
let sitemapCache = null; // { at, xml }
const SITEMAP_CACHE_TTL_MS = 60 * 60 * 1000;

const sitemapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false
});

// GET /sitemap.xml — Dynamic XML sitemap for search engines
router.get('/', sitemapLimiter, async (req, res) => {
  try {
    if (sitemapCache && Date.now() - sitemapCache.at < SITEMAP_CACHE_TTL_MS) {
      res.set('Content-Type', 'application/xml');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(sitemapCache.xml);
    }

    const posts = await BlogPost.find({ status: 'published' })
      .sort({ publishedAt: -1 })
      .select('slug updatedAt publishedAt')
      .lean();

    const staticPages = [
      { loc: '/', priority: '1.0', changefreq: 'weekly' },
      { loc: '/blog', priority: '0.8', changefreq: 'daily' },
      { loc: '/community/discussions', priority: '0.8', changefreq: 'daily' },
      { loc: '/help', priority: '0.6', changefreq: 'monthly' },
      { loc: '/connect-ai', priority: '0.7', changefreq: 'monthly' },
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
    const wines = await WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
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

    // One aggregation per collection instead of one countDocuments per taxon
    // (same helper the public taxonomy lists use).
    const [countries, regions, grapes, countByCountry, countByRegion, countByGrape, countByType] = await Promise.all([
      Country.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
      Region.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
      Grape.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
      countWinesBy('country'),
      countWinesBy('region'),
      countWinesBy('grapes', { unwind: true }),
      countWinesBy('type'),
    ]);

    for (const c of countries) {
      const count = countByCountry.get(String(c._id)) || 0;
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
      const count = countByRegion.get(String(r._id)) || 0;
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
      const count = countByGrape.get(String(g._id)) || 0;
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
      const count = countByType.get(type) || 0;
      if (count < MIN_WINES) continue;
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/wines/type/${type}</loc>\n`;
      xml += '    <changefreq>monthly</changefreq>\n';
      xml += '    <priority>0.5</priority>\n';
      xml += '  </url>\n';
    }

    // Community discussions — only non-locked threads (locked threads can't accept
    // new replies, so their content is stable but their value-as-a-destination is
    // weaker). Capped at 5000 to stay well under the 50 000 sitemap.xml limit.
    const discussions = await Discussion.find({ isLocked: { $ne: true } })
      .sort({ lastActivityAt: -1 })
      .select('_id slug lastActivityAt replyCount')
      .limit(5000)
      .lean();

    for (const d of discussions) {
      const lastmod = d.lastActivityAt
        ? d.lastActivityAt.toISOString().split('T')[0]
        : d._id.getTimestamp().toISOString().split('T')[0];
      const priority = (d.replyCount || 0) > 10 ? '0.6' : '0.4';
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/community/discussions/${d.slug || d._id}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += '    <changefreq>weekly</changefreq>\n';
      xml += `    <priority>${priority}</priority>\n`;
      xml += '  </url>\n';
    }

    xml += '</urlset>';

    sitemapCache = { at: Date.now(), xml };
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) {
    console.error('[sitemap] generation error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Sitemap generation failed');
  }
});

module.exports = router;
