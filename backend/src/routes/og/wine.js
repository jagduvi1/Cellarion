// The crawler-rendered page of one registry wine. Mounted by routes/og.js.

const express = require('express');
const WineDefinition = require('../../models/WineDefinition');
const { recordRead, readerFor } = require('../../services/registryReadTracker');
const { publicProfileSummary } = require('../../services/registryTiering');
const { servingAdvice, servingSentence } = require('../../utils/servingUtils');
const { buildWinePageContext } = require('../../services/winePageContext');
const { fromNormalized } = require('../../utils/ratingUtils');
const { isValidId } = require('../../utils/validation');
const { SITE_URL, API_URL, esc, serializeJsonLd, ogLimiter } = require('./shared');

const router = express.Router();

// GET /og/wines/:idOrSlug — Full server-rendered HTML for search engine crawlers.
// Nginx routes crawler user-agents here; real users get the SPA.
// Accepts both ObjectId and slug. When given an ObjectId for a wine that has a slug,
// returns 301 to the slug URL — that's how link equity transfers and how external links
// to old ObjectId URLs keep working forever.
router.get('/wines/:idOrSlug', ogLimiter, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId = isValidId(idOrSlug);
    // Quarantined non-wines are 404 to crawlers, matching the taxonomy listing
    // routes below and the sitemap. #844 hid them from every discovery surface
    // but left this detail page serving their title/OG/JSON-LD in full to
    // anything that had the URL (code audit 2026-07-27, M5).
    const hidden = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
    // slugFilter resolves SUPERSEDED slugs too, so a crawler's index entry from
    // before a name correction still resolves — and is 301'd to the new slug
    // below (models/WineDefinition.previousSlugs).
    const filter = isId
      ? { _id: idOrSlug, ...hidden }
      : { ...WineDefinition.slugFilter(idOrSlug), ...hidden };

    const wine = await WineDefinition.findOne(filter)
      .populate(['country', 'region', 'grapes'])
      .select('name producer slug country region appellation classification grapes type image communityRating canary aiProfile')
      .lean();

    if (!wine) {
      return res.status(404).send('Not found');
    }
    // Registry lockdown (2026-09-06, L4): count the read per address so the
    // daily readers report sees crawler and copier volume alike. Never gated
    // here — this is the page verified search crawlers are routed to.
    recordRead(readerFor(req), wine._id);

    // Canonicalise to the CURRENT slug URL when one exists — from an ObjectId
    // URL, and equally from a superseded slug after a name correction. 301
    // means crawlers + browsers both follow, the old URL keeps working, and any
    // link equity it earned transfers to the corrected name.
    if (wine.slug && (isId || String(idOrSlug).toLowerCase() !== wine.slug)) {
      return res.redirect(301, `${SITE_URL}/wines/${wine.slug}`);
    }

    const slugOrId = wine.slug || wine._id;

    // Keep the SEO <title> readable and ~under 60 chars: append the " — Cellarion"
    // brand when it fits, else use the bare wine title, else truncate on a word
    // boundary with an ellipsis. (The old logic sliced mid-word at 57 and dropped
    // the brand for any 48–57-char title.)
    const fullTitle = `${wine.name} — ${wine.producer}`;
    const pageTitle = fullTitle; // og:/twitter: title — the clean wine name
    const BRAND = ' — Cellarion';
    const TITLE_MAX = 60;
    let titleTag;
    if (fullTitle.length + BRAND.length <= TITLE_MAX) {
      titleTag = fullTitle + BRAND;
    } else if (fullTitle.length <= TITLE_MAX) {
      titleTag = fullTitle;
    } else {
      const cut = fullTitle.slice(0, TITLE_MAX - 1);
      const lastSpace = cut.lastIndexOf(' ');
      titleTag = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
    }
    const details = [
      wine.type && wine.type.charAt(0).toUpperCase() + wine.type.slice(1),
      wine.appellation,
      wine.region?.name,
      wine.country?.name
    ].filter(Boolean).join(' · ');
    // The prose tasting profile a signed-out visitor sees on this wine's page
    // (registryTiering: the description and a style sentence, never the
    // structured arrays), so search engines read the page people read.
    const tasting = publicProfileSummary(wine.aiProfile);
    // Wine-level serving line (temperature by the sommelier or the style; no
    // decanting advice, which needs a bottle's age) — the same line the page
    // shows, so readers and crawlers see it too.
    const servingLine = servingSentence(servingAdvice(wine, null));
    // Meta description under 160 chars, cut on a word. With tasting prose it
    // is this wine's own text instead of the line every wine page shares.
    const fullDesc = tasting
      ? `${fullTitle}. ${tasting.description}`
      : `${fullTitle}. ${details}. Discover, track, and manage your wine cellar with Cellarion.`;
    let description = fullDesc;
    if (fullDesc.length > 160) {
      const cut = fullDesc.slice(0, 157);
      const lastSpace = cut.lastIndexOf(' ');
      description = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:]+$/, '') + '…';
    }
    const pageUrl = `${SITE_URL}/wines/${slugOrId}`;
    // wine.image may be a bare filename, an /api/ path, or (legacy admin data)
    // an already-absolute URL — the last must not get API_URL prepended.
    const imageUrl = !wine.image
      ? `${SITE_URL}/cellarion-logo.jpg`
      : wine.image.startsWith('http')
        ? wine.image
        : wine.image.startsWith('/api/')
          ? `${API_URL}${wine.image}`
          : `${API_URL}/api/uploads/${wine.image}`;

    const grapeNames = (wine.grapes || []).map(g => g.name).filter(Boolean);
    const hasRating = wine.communityRating?.reviewCount > 0;
    // Rich-snippet floor (SECURITY_AUDIT_2026-07-08 M-3): reviewCount is the
    // distinct-author count, and a single-author "aggregate" is not an
    // aggregate — require at least 2 distinct authors before emitting
    // schema.org AggregateRating into search-engine structured data.
    const hasAggregate = wine.communityRating?.reviewCount >= 2;

    // The page around the wine, the same as the page people see
    // (services/winePageContext): links, region and grape notes, related
    // wines, and how many vintages have a reviewed drink window. Never the
    // window years: those are for members.
    let context = null;
    try {
      context = await buildWinePageContext(wine, { full: false });
    } catch (e) {
      // Optional — failure here shouldn't break the page render.
    }
    const reviewedVintages = context?.reviewedVintages || 0;

    // Generate a prose paragraph (template, not LLM) — AI engines extract from prose,
    // not from key-value lists.
    const typeWord = wine.type ? wine.type.toLowerCase() : 'wine';
    const placeWords = [wine.appellation, wine.region?.name, wine.country?.name].filter(Boolean).join(', ');
    const grapesPhrase = grapeNames.length === 0
      ? ''
      : grapeNames.length === 1
        ? `Made from ${grapeNames[0]}.`
        : `Made from ${grapeNames.slice(0, -1).join(', ')} and ${grapeNames[grapeNames.length - 1]}.`;
    const classificationPhrase = wine.classification
      ? ` Classified as ${wine.classification}.`
      : '';
    const vintagesWord = reviewedVintages === 1 ? 'vintage' : 'vintages';
    const whenReady = reviewedVintages === 1 ? 'when it is ready' : 'when each one is ready';
    const drinkPhrase = reviewedVintages > 0
      ? ` Cellarion's sommeliers have reviewed the drink window of ${reviewedVintages} ${vintagesWord}; members see ${whenReady}.`
      : '';
    const ratingPhrase = hasRating
      ? ` Cellarion users rate it ${fromNormalized(wine.communityRating.averageNormalized, '5').toFixed(1)} out of 5 across ${wine.communityRating.reviewCount} ${wine.communityRating.reviewCount === 1 ? 'review' : 'reviews'}.`
      : '';
    const proseParagraph = `${wine.name} is a ${typeWord} produced by ${wine.producer}${placeWords ? ` in ${placeWords}` : ''}.${classificationPhrase} ${grapesPhrase}${drinkPhrase}${ratingPhrase} Track this wine and manage your cellar with Cellarion — the free, open-source wine app at cellarion.app.`.replace(/\s+/g, ' ').trim();

    // Per-wine FAQ — only emit a question when the underlying data exists. AI engines
    // love quoting Q&A pairs verbatim; this is what shows up in chat answers.
    const faqs = [];
    if (placeWords) {
      faqs.push({
        q: `Where is ${wine.name} from?`,
        a: `${wine.name} is produced by ${wine.producer} in ${placeWords}.`
      });
    }
    if (grapeNames.length > 0) {
      faqs.push({
        q: `What grapes are in ${wine.name}?`,
        a: grapeNames.length === 1
          ? `${wine.name} is made from ${grapeNames[0]}.`
          : `${wine.name} is a blend of ${grapeNames.slice(0, -1).join(', ')} and ${grapeNames[grapeNames.length - 1]}.`
      });
    }

    // JSON-LD structured data — only use Product type when we have aggregateRating,
    // otherwise Google flags it as invalid (requires offers, review, or aggregateRating).
    const ratingOn5 = hasRating ? fromNormalized(wine.communityRating.averageNormalized, '5') : null;
    const mainEntity = (hasAggregate && ratingOn5 != null)
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

    const graph = [
      mainEntity,
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: 'Wines', item: `${SITE_URL}/wines` },
          { '@type': 'ListItem', position: 3, name: wine.name, item: pageUrl }
        ]
      }
    ];
    if (faqs.length > 0) {
      graph.push({
        '@type': 'FAQPage',
        mainEntity: faqs.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a }
        }))
      });
    }
    const jsonLd = { '@context': 'https://schema.org', '@graph': graph };

    // Links and sections from the page context; a place or grape whose page
    // does not exist stays plain text.
    const linkTo = (entry, name) => (entry?.path
      ? `<a href="${esc(SITE_URL + entry.path)}">${esc(entry.name)}</a>`
      : esc(name));
    const grapeEntries = new Map((context?.grapes || []).map((g) => [g.name, g]));
    const regionNote = context?.region?.excerpt
      ? `<h3>${linkTo(context.region, context.region.name)}${wine.country?.name ? `, ${esc(wine.country.name)}` : ''}</h3><p>${esc(context.region.excerpt)}</p>`
      : '';
    const grapeNotes = (context?.grapes || []).filter((g) => g.excerpt)
      .map((g) => `<h3>${linkTo(g, g.name)}</h3><p>${esc(g.excerpt)}</p>`).join('');
    const whereFromHtml = regionNote || grapeNotes
      ? `<section><h2>Where it comes from</h2>${regionNote}${grapeNotes}</section>`
      : '';
    const wineItems = (list) => list.map((w) => `<li><a href="${esc(SITE_URL + w.path)}">${esc(w.name)}</a> — ${esc(w.producer)}${w.place ? `, ${esc(w.place)}` : ''}</li>`).join('');
    const sameProducer = context?.sameProducer || [];
    const similar = context?.similar || [];
    const moreWinesHtml = sameProducer.length || similar.length
      ? `<section><h2>More wines</h2>${sameProducer.length ? `<h3>From ${esc(wine.producer)}</h3><ul>${wineItems(sameProducer)}</ul>` : ''}${similar.length ? `<h3>More ${esc(typeWord)} wines from ${esc(wine.region?.name || '')}</h3><ul>${wineItems(similar)}</ul>` : ''}</section>`
      : '';

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
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
  ${wine.canary === true ? '<meta name="robots" content="noindex, nofollow" />' : ''}
</head>
<body>
  <header>
    <h1>${esc(wine.name)}</h1>
    <p>${esc(wine.producer)}</p>
  </header>
  <main>
    <p>${esc(proseParagraph)}</p>
    ${wine.type ? `<p><strong>Type:</strong> ${esc(wine.type.charAt(0).toUpperCase() + wine.type.slice(1))}</p>` : ''}
    ${wine.appellation ? `<p><strong>Appellation:</strong> ${esc(wine.appellation)}</p>` : ''}
    ${wine.classification ? `<p><strong>Classification:</strong> ${esc(wine.classification)}</p>` : ''}
    ${wine.region?.name ? `<p><strong>Region:</strong> ${linkTo(context?.region, wine.region.name)}</p>` : ''}
    ${wine.country?.name ? `<p><strong>Country:</strong> ${linkTo(context?.country, wine.country.name)}</p>` : ''}
    ${grapeNames.length > 0 ? `<p><strong>Grapes:</strong> ${grapeNames.map((n) => linkTo(grapeEntries.get(n), n)).join(', ')}</p>` : ''}
    ${hasRating && ratingOn5 != null ? `<p><strong>Community rating:</strong> ${ratingOn5.toFixed(1)}/5 from ${wine.communityRating.reviewCount} ${wine.communityRating.reviewCount === 1 ? 'review' : 'reviews'}</p>` : ''}
    ${wine.image ? `<img src="${esc(imageUrl)}" alt="${esc(wine.name)}" width="300" />` : ''}
    ${tasting ? `<section><h2>Tasting profile${tasting.source === 'ai' ? ' (AI-generated)' : ''}</h2>${tasting.style ? `<p><strong>Structure:</strong> ${esc(tasting.style)}</p>` : ''}<p>${esc(tasting.description)}</p></section>` : ''}
    ${servingLine ? `<p><strong>Serving:</strong> ${esc(servingLine)}</p>` : ''}
    ${reviewedVintages > 0 ? `<section><h2>When to drink</h2><p>Cellarion's sommeliers have reviewed the drink window of ${reviewedVintages} ${vintagesWord} of ${esc(wine.name)}. <a href="${esc(SITE_URL)}/login?mode=register">Sign up free</a> to see ${whenReady}.</p></section>` : ''}
    ${whereFromHtml}
    ${moreWinesHtml}
    ${faqs.length > 0 ? `<section><h2>Frequently asked questions</h2>${faqs.map(({ q, a }) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}</section>` : ''}
  </main>
  <footer>
    <p>Discover, track, and manage your wine cellar with <a href="${esc(SITE_URL)}">Cellarion</a>.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    // The same URL answers the SPA shell to a browser: a shared cache must
    // key on the user agent, or a visitor gets the crawler page for an hour.
    res.set('Vary', 'User-Agent');
    // A canary (a wine that does not exist) is served like any other — that is
    // what makes it evidence — but search engines are told to drop it.
    if (wine.canary === true) res.set('X-Robots-Tag', 'noindex, nofollow');
    res.send(html);
  } catch (err) {
    console.error('[og] wine page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

module.exports = router;
