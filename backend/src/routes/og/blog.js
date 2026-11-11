// The crawler-rendered blog: the index of published posts and one post.
// Mounted by routes/og.js.

const express = require('express');
const BlogPost = require('../../models/BlogPost');
const { sanitizeBlogHtml, extractFaqFromHtml, extractHowToFromHtml } = require('../../utils/sanitizeHtml');
const { SITE_URL, esc, serializeJsonLd, ogLimiter } = require('./shared');

const router = express.Router();

// GET /og/blog — Server-rendered blog index for crawlers. Nginx routes the bare
// "/blog" SPA route for crawler user-agents here; individual posts are handled
// by /og/blog/:slug below.
router.get('/blog', ogLimiter, async (req, res) => {
  try {
    const posts = await BlogPost.find({ status: 'published' })
      .sort({ publishedAt: -1 })
      .select('title slug excerpt metaDescription publishedAt')
      .limit(50)
      .lean();

    const pageUrl = `${SITE_URL}/blog`;
    const title = 'Cellarion Blog';
    const metaDescription = 'Wine cellar tips, storage and serving guides, drink-window advice, and product updates from Cellarion.';

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: title,
          description: metaDescription,
          url: pageUrl,
          isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` },
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: posts.length,
            itemListElement: posts.map((p, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: `${SITE_URL}/blog/${p.slug}`,
              name: p.title,
            })),
          },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
            { '@type': 'ListItem', position: 2, name: title, item: pageUrl },
          ],
        },
      ],
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
  <meta property="og:image" content="${esc(SITE_URL)}/cellarion-logo.jpg" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <nav><a href="${esc(SITE_URL)}">Cellarion</a> / ${esc(title)}</nav>
  <header>
    <h1>${esc(title)}</h1>
    <p>${esc(metaDescription)}</p>
  </header>
  <main>
    ${posts.length === 0 ? '<p>No posts yet.</p>' : `<ul>${posts.map(p => {
      const desc = p.metaDescription || p.excerpt || '';
      const date = p.publishedAt ? new Date(p.publishedAt).toISOString().split('T')[0] : '';
      return `<li><a href="${esc(`${SITE_URL}/blog/${p.slug}`)}"><strong>${esc(p.title)}</strong></a>${date ? ` — <time datetime="${esc(date)}">${esc(date)}</time>` : ''}${desc ? `<br/><small>${esc(desc)}</small>` : ''}</li>`;
    }).join('')}</ul>`}
  </main>
  <footer>
    <p><a href="${esc(SITE_URL)}">Cellarion</a> — your wine cellar, beautifully organised.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] blog index error:', err.message);
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

    // Render the article body as structured HTML (headings, lists, images) so
    // AI/search engines get a real document outline — not a flat, truncated text
    // blob. sanitizeBlogHtml strips scripts/handlers/dangerous schemes.
    const safeContent = sanitizeBlogHtml(post.content || '');

    // Auto-derive a FAQ from any question-style headings in the post. Emitted as
    // FAQPage JSON-LD only when there are ≥2 pairs — the Q&A is visible in the
    // body above, so the markup matches the page (Google's FAQ requirement).
    const faqs = extractFaqFromHtml(safeContent);

    // Auto-derive HowTo steps from "Step N" <h2> headings in the post. Emitted as
    // HowTo JSON-LD only when there are ≥2 steps — the steps are visible in the
    // body, so the structured data matches the page. This is the high-signal
    // format AI answer engines quote for "how do I…" procedural queries.
    const howToSteps = extractHowToFromHtml(safeContent);

    const graph = [
      {
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
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: `${SITE_URL}/blog` },
          { '@type': 'ListItem', position: 3, name: post.title, item: postUrl }
        ]
      }
    ];
    if (howToSteps.length >= 2) {
      graph.push({
        '@type': 'HowTo',
        name: post.title,
        description: metaDescription,
        step: howToSteps.map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.name,
          text: s.text
        }))
      });
    }
    if (faqs.length >= 2) {
      graph.push({
        '@type': 'FAQPage',
        mainEntity: faqs.map(({ question, answer }) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer }
        }))
      });
    }
    const jsonLd = { '@context': 'https://schema.org', '@graph': graph };

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
  ${publishedDate ? `<meta property="article:published_time" content="${esc(new Date(post.publishedAt).toISOString())}" />` : ''}
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(metaTitle)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  ${post.coverImage ? `<meta name="twitter:image" content="${esc(post.coverImage)}" />` : ''}
  <link rel="canonical" href="${esc(postUrl)}" />
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
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
    <div>${safeContent}</div>
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

module.exports = router;
