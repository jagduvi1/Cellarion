const express = require('express');
const rateLimit = require('express-rate-limit');
const WineDefinition = require('../models/WineDefinition');
const BlogPost = require('../models/BlogPost');
const { fromNormalized } = require('../utils/ratingUtils');
const { isValidId } = require('../utils/validation');

const router = express.Router();

const ogLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';
const API_URL = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app';

// GET /og/wines/:id — Full server-rendered HTML for search engine crawlers.
// Nginx routes crawler user-agents here; real users get the SPA.
router.get('/wines/:id', ogLimiter, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).send('Not found');
    const wine = await WineDefinition.findById(req.params.id)
      .populate(['country', 'region', 'grapes'])
      .select('name producer country region appellation classification grapes type image communityRating')
      .lean();

    if (!wine) {
      return res.status(404).send('Not found');
    }

    // Keep title under 60 chars for SEO — drop " — Cellarion" suffix if needed
    const fullTitle = `${wine.name} — ${wine.producer}`;
    const pageTitle = fullTitle.length > 47 ? fullTitle.slice(0, 57) : fullTitle;
    const titleTag = pageTitle.length > 47 ? pageTitle : `${pageTitle} — Cellarion`;
    const details = [
      wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
      wine.appellation,
      wine.region?.name,
      wine.country?.name
    ].filter(Boolean).join(' · ');
    // Keep meta description under 160 chars
    const fullDesc = `${fullTitle}. ${details}. Discover, track, and manage your wine cellar with Cellarion.`;
    const description = fullDesc.length > 160 ? fullDesc.slice(0, 157) + '...' : fullDesc;
    const pageUrl = `${SITE_URL}/wines/${wine._id}`;
    const imageUrl = wine.image
      ? (wine.image.startsWith('/api/') || wine.image.startsWith('http') ? `${API_URL}${wine.image}` : `${API_URL}/api/uploads/${wine.image}`)
      : `${SITE_URL}/cellarion-logo.jpg`;

    const grapeNames = (wine.grapes || []).map(g => g.name).filter(Boolean);
    const hasRating = wine.communityRating?.reviewCount > 0;

    // JSON-LD structured data — only use Product type when we have aggregateRating,
    // otherwise Google flags it as invalid (requires offers, review, or aggregateRating).
    const ratingOn5 = hasRating ? fromNormalized(wine.communityRating.averageNormalized, '5') : null;
    const mainEntity = (hasRating && ratingOn5 != null)
      ? {
          '@type': 'Product',
          name: wine.name,
          description,
          brand: { '@type': 'Brand', name: wine.producer },
          image: imageUrl,
          url: pageUrl,
          category: wine.type ? `${wine.type} wine` : 'wine',
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: ratingOn5.toFixed(1),
            bestRating: '5',
            reviewCount: wine.communityRating.reviewCount
          }
        }
      : {
          '@type': 'WebPage',
          name: wine.name,
          description,
          url: pageUrl
        };

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        mainEntity,
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
            { '@type': 'ListItem', position: 2, name: 'Wines', item: `${SITE_URL}/wines` },
            { '@type': 'ListItem', position: 3, name: wine.name, item: pageUrl }
          ]
        }
      ]
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(titleTag)}</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="${hasRating ? 'product' : 'website'}" />
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
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <header>
    <h1>${esc(wine.name)}</h1>
    <p>${esc(wine.producer)}</p>
  </header>
  <main>
    ${wine.type ? `<p><strong>Type:</strong> ${esc(wine.type.charAt(0).toUpperCase() + wine.type.slice(1))}</p>` : ''}
    ${wine.appellation ? `<p><strong>Appellation:</strong> ${esc(wine.appellation)}</p>` : ''}
    ${wine.classification ? `<p><strong>Classification:</strong> ${esc(wine.classification)}</p>` : ''}
    ${wine.region?.name ? `<p><strong>Region:</strong> ${esc(wine.region.name)}</p>` : ''}
    ${wine.country?.name ? `<p><strong>Country:</strong> ${esc(wine.country.name)}</p>` : ''}
    ${grapeNames.length > 0 ? `<p><strong>Grapes:</strong> ${esc(grapeNames.join(', '))}</p>` : ''}
    ${hasRating && ratingOn5 != null ? `<p><strong>Community rating:</strong> ${ratingOn5.toFixed(1)}/5 from ${wine.communityRating.reviewCount} ${wine.communityRating.reviewCount === 1 ? 'review' : 'reviews'}</p>` : ''}
    ${wine.image ? `<img src="${esc(imageUrl)}" alt="${esc(wine.name)}" width="300" />` : ''}
  </main>
  <footer>
    <p>Discover, track, and manage your wine cellar with <a href="${esc(SITE_URL)}">Cellarion</a>.</p>
  </footer>
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

// GET /og/blog/:slug — Full server-rendered HTML for blog post crawlers.
router.get('/blog/:slug', ogLimiter, async (req, res) => {
  try {
    const post = await BlogPost.findOne({ slug: req.params.slug, status: 'published' })
      .populate('author', 'username')
      .lean();

    if (!post) {
      return res.status(404).send('Not found');
    }

    const metaTitle = post.metaTitle || post.title;
    const metaDescription = post.metaDescription || post.excerpt || `${post.title} — Cellarion Blog`;
    const postUrl = `${SITE_URL}/blog/${post.slug}`;
    const publishedDate = post.publishedAt ? new Date(post.publishedAt).toISOString().split('T')[0] : '';
    const modifiedDate = post.updatedAt ? new Date(post.updatedAt).toISOString().split('T')[0] : '';

    // Strip HTML tags from content for a text-only body
    const textContent = post.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: metaDescription,
      datePublished: post.publishedAt,
      dateModified: post.updatedAt,
      author: post.author?.username
        ? { '@type': 'Person', name: post.author.username }
        : { '@type': 'Organization', name: 'Cellarion', url: SITE_URL },
      publisher: {
        '@type': 'Organization',
        name: 'Cellarion',
        url: SITE_URL,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/cellarion-logo.jpg` }
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': postUrl },
      ...(post.coverImage ? { image: post.coverImage } : {})
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(metaTitle)} — Cellarion Blog</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(metaTitle)}" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  ${post.coverImage ? `<meta property="og:image" content="${esc(post.coverImage)}" />` : ''}
  <meta property="og:url" content="${esc(postUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  ${publishedDate ? `<meta property="article:published_time" content="${esc(post.publishedAt)}" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(metaTitle)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  ${post.coverImage ? `<meta name="twitter:image" content="${esc(post.coverImage)}" />` : ''}
  <link rel="canonical" href="${esc(postUrl)}" />
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
  <nav><a href="${esc(SITE_URL)}/blog">Cellarion Blog</a> / ${esc(post.title)}</nav>
  <article>
    <header>
      <h1>${esc(post.title)}</h1>
      ${publishedDate ? `<time datetime="${esc(publishedDate)}">${esc(publishedDate)}</time>` : ''}
      ${post.author?.username ? `<p>By ${esc(post.author.username)}</p>` : ''}
      ${post.tags?.length ? `<p>Tags: ${post.tags.map(t => esc(t)).join(', ')}</p>` : ''}
    </header>
    ${post.coverImage ? `<img src="${esc(post.coverImage)}" alt="${esc(post.title)}" width="800" />` : ''}
    <div>${textContent.slice(0, 5000)}</div>
  </article>
  <footer>
    <p><a href="${esc(SITE_URL)}/blog">Back to blog</a> · <a href="${esc(SITE_URL)}">Cellarion</a></p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] blog page error:', err.message);
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
