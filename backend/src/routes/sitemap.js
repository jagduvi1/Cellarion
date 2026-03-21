const express = require('express');
const rateLimit = require('express-rate-limit');
const BlogPost = require('../models/BlogPost');

const router = express.Router();

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';

const sitemapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
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
