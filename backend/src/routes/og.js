const express = require('express');
const WineDefinition = require('../models/WineDefinition');

const router = express.Router();

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';
const API_URL = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app';

// GET /og/wines/:id — Returns minimal HTML with OG meta tags for social media crawlers.
// Nginx routes crawler user-agents here; real users get the SPA.
router.get('/wines/:id', async (req, res) => {
  try {
    const wine = await WineDefinition.findById(req.params.id)
      .populate(['country', 'region', 'grapes'])
      .select('name producer country region appellation grapes type image communityRating')
      .lean();

    if (!wine) {
      return res.status(404).send('Not found');
    }

    const pageTitle = `${wine.name} — ${wine.producer}`;
    const details = [
      wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
      wine.appellation,
      wine.region?.name,
      wine.country?.name
    ].filter(Boolean).join(' · ');
    const description = `${pageTitle}. ${details}. Discover, track, and manage your wine cellar with Cellarion.`;
    const pageUrl = `${SITE_URL}/wines/${wine._id}`;
    const imageUrl = wine.image
      ? (wine.image.startsWith('/api/') || wine.image.startsWith('http') ? `${API_URL}${wine.image}` : `${API_URL}/api/uploads/${wine.image}`)
      : `${SITE_URL}/cellarion-logo.jpg`;

    // Minimal HTML — crawlers only read the <head>
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(pageTitle)} — Cellarion</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="product" />
  <meta property="og:title" content="${esc(pageTitle)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(imageUrl)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(pageTitle)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(imageUrl)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <meta http-equiv="refresh" content="0;url=${esc(pageUrl)}" />
</head>
<body>
  <p>Redirecting to <a href="${esc(pageUrl)}">${esc(pageTitle)}</a>...</p>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] wine page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// Escape HTML entities for safe embedding in HTML attributes
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = router;
