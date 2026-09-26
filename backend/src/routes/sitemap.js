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

/**
 * The XML sitemap, as an index of smaller files.
 *
 *   /sitemap.xml                         → sitemap index (the URL robots.txt names)
 *   /sitemap.xml?part=pages              → site pages, blog posts, taxonomy pages
 *   /sitemap.xml?part=wines-N            → public wine pages, URLS_PER_FILE per file
 *   /sitemap.xml?part=discussions-N      → open community threads, same paging
 *
 * The single file this replaces listed at most 5,000 wines (the most recently
 * updated) and 5,000 threads — with ~10.7k wines, over half of the public wine
 * pages were never offered to search engines (scaling audit 2026-09-25). The
 * parts stay on the /sitemap.xml path so they may list any URL of the site
 * (a sitemap only covers URLs under its own directory), and so no proxy change
 * is needed: nginx already forwards /sitemap.xml with its query string.
 */

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3;

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';

// sitemaps.org allows 50,000 URLs (and 50 MB) per file; stay well under.
const URLS_PER_FILE = 40000;

// Server-side cache: crawlers ignore Cache-Control per-client, and a part is
// a registry-wide query. Content changes slowly, so an hour-stale sitemap is
// fine. The total is capped: at a million wines the parts add up to well over
// 100 MB, more than this process may hold — an evicted part is rebuilt on its
// next request.
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_CHARS = 16 * 1024 * 1024;

// The rows the public pages serve (routes/og.js): a quarantined non-wine or a
// half-identified wine — every private draft is one (draft ⇒ pendingIdentity)
// — is a 404 there. Canaries ARE listed: their pages carry noindex, and being
// on every path a copier walks is what they are for (models/WineDefinition).
const WINE_FILTER = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
// Locked threads take no replies; they stay out, as before.
const DISCUSSION_FILTER = { isLocked: { $ne: true } };

const PART = /^(?:pages|(wines|discussions)-([1-9]\d{0,5}))$/;

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
const day = (d) => (d ? new Date(d).toISOString().split('T')[0] : '');

// A sitemap URL must be percent-encoded (the rosé type page) and then
// entity-escaped for XML.
const loc = (path) => esc(encodeURI(SITE_URL + path));

function url({ loc: path, lastmod, changefreq, priority }) {
  let x = `  <url>\n    <loc>${loc(path)}</loc>\n`;
  if (lastmod) x += `    <lastmod>${lastmod}</lastmod>\n`;
  if (changefreq) x += `    <changefreq>${changefreq}</changefreq>\n`;
  if (priority) x += `    <priority>${priority}</priority>\n`;
  return `${x}  </url>\n`;
}

const urlset = (entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('')}</urlset>`;

async function buildIndex(urlsPerFile) {
  const [wines, discussions] = await Promise.all([
    WineDefinition.countDocuments(WINE_FILTER),
    Discussion.countDocuments(DISCUSSION_FILTER),
  ]);
  const parts = ['pages'];
  for (let i = 1; i <= Math.ceil(wines / urlsPerFile); i++) parts.push(`wines-${i}`);
  for (let i = 1; i <= Math.ceil(discussions / urlsPerFile); i++) parts.push(`discussions-${i}`);
  const entries = parts.map((p) => `  <sitemap>\n    <loc>${loc(`/sitemap.xml?part=${p}`)}</loc>\n  </sitemap>\n`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('')}</sitemapindex>`;
}

async function buildPages() {
  const staticPages = [
    { loc: '/', priority: '1.0', changefreq: 'weekly' },
    { loc: '/blog', priority: '0.8', changefreq: 'daily' },
    { loc: '/community/discussions', priority: '0.8', changefreq: 'daily' },
    { loc: '/help', priority: '0.6', changefreq: 'monthly' },
    { loc: '/connect-ai', priority: '0.7', changefreq: 'monthly' },
    { loc: '/privacy', priority: '0.3', changefreq: 'yearly' },
  ];

  // Taxonomy pages — only entries that meet the minimum wine threshold, so no
  // empty page is submitted. One aggregation per collection instead of one
  // countDocuments per taxon (the same helper the public taxonomy lists use).
  const [posts, countries, regions, grapes, countByCountry, countByRegion, countByGrape, countByType] = await Promise.all([
    BlogPost.find({ status: 'published' }).sort({ publishedAt: -1 }).select('slug updatedAt publishedAt').lean(),
    Country.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
    Region.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
    Grape.find({ slug: { $exists: true, $ne: null } }).select('slug updatedAt').lean(),
    countWinesBy('country'),
    countWinesBy('region'),
    countWinesBy('grapes', { unwind: true }),
    countWinesBy('type'),
  ]);

  const entries = staticPages.map(url);
  for (const post of posts) {
    entries.push(url({ loc: `/blog/${post.slug}`, lastmod: day(post.updatedAt || post.publishedAt), changefreq: 'monthly', priority: '0.7' }));
  }
  const taxa = [[countries, countByCountry, 'countries'], [regions, countByRegion, 'regions'], [grapes, countByGrape, 'grapes']];
  for (const [docs, counts, path] of taxa) {
    for (const t of docs) {
      if ((counts.get(String(t._id)) || 0) < MIN_WINES) continue;
      entries.push(url({ loc: `/${path}/${t.slug}`, lastmod: day(t.updatedAt), changefreq: 'monthly', priority: '0.6' }));
    }
  }
  for (const type of WINE_TYPES) {
    if ((countByType.get(type) || 0) < MIN_WINES) continue;
    entries.push(url({ loc: `/wines/type/${type}`, changefreq: 'monthly', priority: '0.5' }));
  }
  return urlset(entries);
}

// Paged by _id: a new wine or thread lands on the last file, so the earlier
// files stay the same between crawls.
async function buildWines(page, urlsPerFile) {
  const wines = await WineDefinition.find(WINE_FILTER)
    .sort({ _id: 1 })
    .skip((page - 1) * urlsPerFile)
    .limit(urlsPerFile)
    .select('_id slug updatedAt')
    .lean();
  if (wines.length === 0) return null;
  // Slug URLs when available (human-readable, AI-citable); the ObjectId URL
  // for any wine without one, so the list stays complete.
  return urlset(wines.map((w) => url({
    loc: `/wines/${w.slug || w._id}`,
    lastmod: day(w.updatedAt || w._id.getTimestamp()),
    changefreq: 'monthly',
    priority: '0.5',
  })));
}

async function buildDiscussions(page, urlsPerFile) {
  const discussions = await Discussion.find(DISCUSSION_FILTER)
    .sort({ _id: 1 })
    .skip((page - 1) * urlsPerFile)
    .limit(urlsPerFile)
    .select('_id slug lastActivityAt replyCount')
    .lean();
  if (discussions.length === 0) return null;
  return urlset(discussions.map((d) => url({
    loc: `/community/discussions/${d.slug || d._id}`,
    lastmod: day(d.lastActivityAt || d._id.getTimestamp()),
    changefreq: 'weekly',
    priority: (d.replyCount || 0) > 10 ? '0.6' : '0.4',
  })));
}

/** An hour-long cache, capped in total size; the oldest part goes first. */
function createCache({ ttlMs, maxChars }) {
  const entries = new Map(); // part -> { at, xml }
  let size = 0;
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    entries.delete(key);
    size -= e.xml.length;
  };
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (Date.now() - e.at > ttlMs) { drop(key); return null; }
      return e.xml;
    },
    set(key, xml) {
      drop(key);
      if (xml.length > maxChars) return;
      entries.set(key, { at: Date.now(), xml });
      size += xml.length;
      for (const k of entries.keys()) {
        if (size <= maxChars) break;
        drop(k);
      }
    },
  };
}

const sitemapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // An index plus its parts: room for a crawler to fetch them all.
  max: 60,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false
});

function createSitemapRouter({
  urlsPerFile = URLS_PER_FILE,
  cacheTtlMs = CACHE_TTL_MS,
  cacheMaxChars = CACHE_MAX_CHARS,
  limiter = sitemapLimiter,
} = {}) {
  const router = express.Router();
  const cache = createCache({ ttlMs: cacheTtlMs, maxChars: cacheMaxChars });
  const inFlight = new Map(); // one build per part at a time

  const build = (part) => {
    if (part === 'index') return buildIndex(urlsPerFile);
    if (part === 'pages') return buildPages();
    const [, kind, page] = PART.exec(part);
    return kind === 'wines' ? buildWines(Number(page), urlsPerFile) : buildDiscussions(Number(page), urlsPerFile);
  };

  const notFound = (res) => res.status(404).set({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).send('Not found');

  // GET /sitemap.xml[?part=…]
  router.get('/', limiter, async (req, res) => {
    const part = req.query.part === undefined ? 'index' : String(req.query.part);
    if (part !== 'index' && !PART.test(part)) return notFound(res);
    try {
      let xml = cache.get(part);
      if (xml === null) {
        if (!inFlight.has(part)) {
          inFlight.set(part, build(part).finally(() => inFlight.delete(part)));
        }
        xml = await inFlight.get(part);
        if (xml === null) return notFound(res); // past the last file
        cache.set(part, xml);
      }
      res.set('Content-Type', 'application/xml');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(xml);
    } catch (err) {
      console.error(`[sitemap] ${part} generation error:`, err);
      return res.status(500).set({ 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).send('Sitemap generation failed');
    }
  });

  return router;
}

module.exports = createSitemapRouter();
module.exports.createSitemapRouter = createSitemapRouter;
module.exports.URLS_PER_FILE = URLS_PER_FILE;
