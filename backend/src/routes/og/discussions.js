// The crawler-rendered forum: the list of discussions and one thread with its
// replies. Mounted by routes/og.js.

const express = require('express');
const Discussion = require('../../models/Discussion');
const DiscussionReply = require('../../models/DiscussionReply');
const { isValidId } = require('../../utils/validation');
const { sanitizeForumHtml } = require('../../utils/sanitizeHtml');
const { stripHtml } = require('../../utils/sanitize');
const { SITE_URL, esc, serializeJsonLd, ogLimiter } = require('./shared');

const router = express.Router();

// Human-readable labels for the 5 discussion categories — used in crawler HTML.
const DISCUSSION_CATEGORY_LABELS = {
  'tasting-notes': 'Tasting Notes',
  'food-pairing': 'Food Pairing',
  'recommendations': 'Recommendations',
  'cellar-tips': 'Cellar Tips',
  'general': 'General'
};

// GET /og/community/discussions — Crawler-visible list of recent discussions.
router.get('/community/discussions', ogLimiter, async (req, res) => {
  try {
    const discussions = await Discussion.find({})
      .sort({ isPinned: -1, lastActivityAt: -1 })
      .select('title slug body category replyCount lastActivityAt createdAt')
      .limit(50)
      .lean();

    const pageUrl = `${SITE_URL}/community/discussions`;
    const title = 'Wine Discussions — Cellarion Community';
    const metaDescription = 'Public wine discussion forum: tasting notes, food pairing, cellar tips, and recommendations from Cellarion users.';

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: title,
      description: metaDescription,
      url: pageUrl,
      isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` },
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: discussions.length,
        itemListElement: discussions.map((d, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${SITE_URL}/community/discussions/${d.slug || d._id}`,
          name: d.title
        }))
      }
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <header><h1>Wine Discussions</h1></header>
  <main>
    <p>${esc(metaDescription)}</p>
    ${discussions.length === 0 ? '<p>No discussions yet — be the first to start one.</p>' : `<ul>${discussions.map(d => {
      const url = `${SITE_URL}/community/discussions/${d.slug || d._id}`;
      // Body is HTML — strip to plain text for the preview snippet so we don't
      // leak markup into the list view.
      const plain = stripHtml(d.body || '');
      const preview = plain.slice(0, 160);
      const cat = DISCUSSION_CATEGORY_LABELS[d.category] || d.category;
      return `<li><a href="${esc(url)}"><strong>${esc(d.title)}</strong></a> — ${esc(cat)} · ${d.replyCount || 0} ${d.replyCount === 1 ? 'reply' : 'replies'}<br/><small>${esc(preview)}${plain.length > 160 ? '…' : ''}</small></li>`;
    }).join('')}</ul>`}
  </main>
  <footer>
    <p>Join the conversation on <a href="${esc(SITE_URL)}">Cellarion</a> — track your cellar, get drink-window recommendations, and share notes with other wine drinkers.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(html);
  } catch (err) {
    console.error('[og] community discussions list error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/community/discussions/:idOrSlug — Crawler-visible single discussion thread.
// 301-redirects ObjectId URLs to the slug form when one exists, so link equity
// transfers to the canonical URL.
router.get('/community/discussions/:idOrSlug', ogLimiter, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId = isValidId(idOrSlug);
    const filter = isId ? { _id: idOrSlug } : { slug: String(idOrSlug).toLowerCase() };

    const discussion = await Discussion.findOne(filter)
      .populate('author', 'username displayName')
      .populate({ path: 'wineDefinition', select: 'name producer slug' })
      .lean();

    if (!discussion) {
      return res.status(404).send('Not found');
    }

    if (isId && discussion.slug) {
      return res.redirect(301, `${SITE_URL}/community/discussions/${discussion.slug}`);
    }

    const slugOrId = discussion.slug || discussion._id;
    const pageUrl = `${SITE_URL}/community/discussions/${slugOrId}`;
    const authorName = discussion.author?.displayName || discussion.author?.username || 'Anonymous';
    const cat = DISCUSSION_CATEGORY_LABELS[discussion.category] || discussion.category;

    // Pull the top-level replies (up to 30) for the schema's `comment` array
    // and the visible thread.
    const replies = await DiscussionReply.find({ discussion: discussion._id, isDeleted: { $ne: true } })
      .sort({ createdAt: 1 })
      .limit(30)
      .populate('author', 'username displayName')
      .select('body author createdAt')
      .lean();

    // body is sanitized HTML — strip to plain text for the meta description
    // so we don't leak `<p>` etc. into Google's snippet.
    const plainBody = stripHtml(discussion.body || '');
    const fullDesc = plainBody.slice(0, 160);
    const metaDescription = fullDesc.length > 0 ? fullDesc : `${discussion.title} — Cellarion wine discussion`;
    const datePublished = discussion.createdAt ? new Date(discussion.createdAt).toISOString() : '';
    const dateModified = discussion.lastActivityAt
      ? new Date(discussion.lastActivityAt).toISOString()
      : (discussion.updatedAt ? new Date(discussion.updatedAt).toISOString() : datePublished);

    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'DiscussionForumPosting',
      headline: discussion.title,
      // schema.org expects plain-text article bodies, not HTML
      articleBody: plainBody,
      datePublished,
      dateModified,
      url: pageUrl,
      mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl },
      author: { '@type': 'Person', name: authorName },
      publisher: {
        '@type': 'Organization',
        name: 'Cellarion',
        url: SITE_URL,
        logo: { '@type': 'ImageObject', url: `${SITE_URL}/cellarion-logo.jpg` }
      },
      interactionStatistic: {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/CommentAction',
        userInteractionCount: discussion.replyCount || 0
      },
      ...(replies.length > 0 ? {
        comment: replies.map(r => ({
          '@type': 'Comment',
          text: stripHtml(r.body || ''),
          datePublished: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
          author: { '@type': 'Person', name: r.author?.displayName || r.author?.username || 'Anonymous' }
        }))
      } : {})
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(discussion.title)} — Cellarion</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(discussion.title)}" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta property="og:image" content="${esc(SITE_URL)}/cellarion-logo.jpg" />
  ${datePublished ? `<meta property="article:published_time" content="${esc(datePublished)}" />` : ''}
  ${dateModified ? `<meta property="article:modified_time" content="${esc(dateModified)}" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(discussion.title)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <nav><a href="${esc(SITE_URL)}/community/discussions">Discussions</a> / ${esc(cat)}</nav>
  <article>
    <header>
      <h1>${esc(discussion.title)}</h1>
      <p>By ${esc(authorName)}${datePublished ? ` · <time datetime="${esc(datePublished)}">${esc(datePublished.split('T')[0])}</time>` : ''}</p>
      ${discussion.wineDefinition ? `<p>About: <a href="${esc(SITE_URL)}/wines/${esc(discussion.wineDefinition.slug || discussion.wineDefinition._id)}">${esc(discussion.wineDefinition.name)}${discussion.wineDefinition.producer ? ` — ${esc(discussion.wineDefinition.producer)}` : ''}</a></p>` : ''}
    </header>
    <div>${sanitizeForumHtml(discussion.body || '')}</div>
    ${replies.length > 0 ? `<section><h2>${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</h2>${replies.map(r => {
      const rname = r.author?.displayName || r.author?.username || 'Anonymous';
      const rdate = r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : '';
      return `<div><p><strong>${esc(rname)}</strong>${rdate ? ` <time datetime="${esc(rdate)}">${esc(rdate)}</time>` : ''}</p><div>${sanitizeForumHtml(r.body || '')}</div></div>`;
    }).join('')}</section>` : ''}
  </article>
  <footer>
    <p><a href="${esc(SITE_URL)}/community/discussions">More discussions</a> · <a href="${esc(SITE_URL)}">Cellarion</a> — your wine cellar in the cloud.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(html);
  } catch (err) {
    console.error('[og] community discussion error:', err.message);
    res.status(500).send('Error generating page');
  }
});

module.exports = router;
