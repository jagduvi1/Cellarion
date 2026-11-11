// The crawler-rendered taxonomy pages: a region, a country, a grape and a wine
// type, each with the wines that use it. Mounted by routes/og.js.

const express = require('express');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const { SITE_URL, esc, serializeJsonLd, hreflangLinks, ogLimiter } = require('./shared');
const { MIN_WINES } = require('../../config/taxonomyPages');

const router = express.Router();

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

// The crawler taxonomy pages list what the API's first pages list: never a
// canary (they sit only in the API's deep pages, routes/taxonomy.js), so the
// two cannot be compared to pick the canaries out.
const TAXONOMY_LISTED = { nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true } };

// ── Shared taxonomy renderer ─────────────────────────────────────────────────
// Draws all four pages below: a CollectionPage with ItemList JSON-LD, a prose
// description, the wines and the questions.

function taxonomyHtml({ title, description, metaDescription, pageUrl, itemType, additionalType, faqs, wineList, breadcrumb, imageUrl }) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['CollectionPage', itemType],
        ...(additionalType ? { additionalType } : {}),
        name: title,
        description: metaDescription,
        url: pageUrl,
        ...(imageUrl ? { image: imageUrl } : {}),
        isPartOf: { '@type': 'WebSite', '@id': `${SITE_URL}/#website` }
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumb.map((b, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: b.name,
          item: b.item
        }))
      },
      ...(wineList.length > 0 ? [{
        '@type': 'ItemList',
        name: `Wines — ${title}`,
        numberOfItems: wineList.length,
        itemListElement: wineList.map((w, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          url: `${SITE_URL}/wines/${w.slug || w._id}`,
          name: w.name
        }))
      }] : []),
      ...(faqs && faqs.length > 0 ? [{
        '@type': 'FAQPage',
        mainEntity: faqs.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a }
        }))
      }] : [])
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)} — Cellarion</title>
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
${hreflangLinks(pageUrl)}
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <header>
    <h1>${esc(title)}</h1>
  </header>
  <main>
    ${description ? `<p>${esc(description)}</p>` : ''}
    ${wineList.length > 0
      ? `<h2>Wines</h2><ul>${wineList.map(w =>
          `<li><a href="${esc(`${SITE_URL}/wines/${w.slug || w._id}`)}">${esc(w.name)}${w.producer ? ` — ${esc(w.producer)}` : ''}</a></li>`
        ).join('')}</ul>`
      : ''}
    ${faqs && faqs.length > 0
      ? `<section><h2>Frequently asked questions</h2>${faqs.map(({ q, a }) =>
          `<h3>${esc(q)}</h3><p>${esc(a)}</p>`
        ).join('')}</section>`
      : ''}
  </main>
  <footer>
    <p>Discover, track, and manage your wine cellar with <a href="${esc(SITE_URL)}">Cellarion</a>.</p>
  </footer>
</body>
</html>`;
}

// GET /og/regions/:slug
router.get('/regions/:slug', ogLimiter, async (req, res) => {
  try {
    const region = await Region.findOne({ slug: String(req.params.slug).toLowerCase() })
      .populate('country', 'name slug')
      .populate('typicalGrapes', 'name slug')
      .select('name slug description classification country typicalGrapes')
      .lean();
    if (!region) return res.status(404).send('Not found');

    const wines = await WineDefinition.find({ region: region._id, ...TAXONOMY_LISTED })
      .select('name producer slug _id')
      .sort({ name: 1 })
      .limit(20)
      .lean();

    if (wines.length < MIN_WINES) return res.status(404).send('Not found');

    const pageUrl = `${SITE_URL}/regions/${region.slug}`;
    const metaDescription = (region.description
      ? region.description.slice(0, 157)
      : `Discover ${region.name} wines${region.country?.name ? ` from ${region.country.name}` : ''}. Browse producers, styles, and cellar-worthy bottles on Cellarion.`
    ).replace(/\n/g, ' ');

    const faqs = [
      {
        q: `What wines are produced in ${region.name}?`,
        a: wines.slice(0, 5).map(w => w.name).join(', ') + (wines.length > 5 ? ' and more.' : '.')
      },
      ...(region.typicalGrapes?.length > 0 ? [{
        q: `What grapes are typical in ${region.name}?`,
        a: region.typicalGrapes.map(g => g.name).join(', ') + '.'
      }] : []),
      ...(region.country?.name ? [{
        q: `Where is ${region.name}?`,
        a: `${region.name} is a wine region in ${region.country.name}.`
      }] : [])
    ];

    const html = taxonomyHtml({
      title: region.name,
      description: region.description || '',
      metaDescription,
      pageUrl,
      itemType: 'Place',
      faqs,
      wineList: wines,
      breadcrumb: [
        { name: 'Cellarion', item: SITE_URL },
        ...(region.country ? [{ name: region.country.name, item: `${SITE_URL}/countries/${region.country.slug || region.country._id}` }] : []),
        { name: region.name, item: pageUrl }
      ]
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] region error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/countries/:slug
router.get('/countries/:slug', ogLimiter, async (req, res) => {
  try {
    const country = await Country.findOne({ slug: String(req.params.slug).toLowerCase() })
      .select('name slug description code')
      .lean();
    if (!country) return res.status(404).send('Not found');

    const wines = await WineDefinition.find({ country: country._id, ...TAXONOMY_LISTED })
      .select('name producer slug _id')
      .sort({ name: 1 })
      .limit(20)
      .lean();

    if (wines.length < MIN_WINES) return res.status(404).send('Not found');

    const pageUrl = `${SITE_URL}/countries/${country.slug}`;
    const metaDescription = (country.description
      ? country.description.slice(0, 157)
      : `Explore wines from ${country.name}. Browse producers, regions, and bottles tracked by Cellarion collectors worldwide.`
    ).replace(/\n/g, ' ');

    const faqs = [{
      q: `What wines come from ${country.name}?`,
      a: wines.slice(0, 5).map(w => w.name).join(', ') + (wines.length > 5 ? ' and many more.' : '.')
    }];

    const html = taxonomyHtml({
      title: country.name,
      description: country.description || '',
      metaDescription,
      pageUrl,
      itemType: 'Country',
      faqs,
      wineList: wines,
      breadcrumb: [
        { name: 'Cellarion', item: SITE_URL },
        { name: country.name, item: pageUrl }
      ]
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] country error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/grapes/:slug
router.get('/grapes/:slug', ogLimiter, async (req, res) => {
  try {
    const grape = await Grape.findOne({ slug: String(req.params.slug).toLowerCase() })
      .select('name slug color origin characteristics agingPotential synonyms description')
      .lean();
    if (!grape) return res.status(404).send('Not found');

    const wines = await WineDefinition.find({ grapes: grape._id, ...TAXONOMY_LISTED })
      .select('name producer slug _id')
      .sort({ name: 1 })
      .limit(20)
      .lean();

    if (wines.length < MIN_WINES) return res.status(404).send('Not found');

    const pageUrl = `${SITE_URL}/grapes/${grape.slug}`;
    const colorWord = grape.color ? grape.color.toLowerCase() : '';
    const metaDescription = (grape.description
      ? grape.description.slice(0, 157)
      : `${grape.name} is a ${colorWord ? colorWord + ' ' : ''}wine grape${grape.origin ? ` originating in ${grape.origin}` : ''}. Discover ${grape.name} wines tracked on Cellarion.`
    ).replace(/\n/g, ' ');

    const faqs = [
      ...(grape.characteristics?.length > 0 ? [{
        q: `What are the characteristics of ${grape.name}?`,
        a: grape.characteristics.join(', ') + '.'
      }] : []),
      ...(grape.agingPotential ? [{
        q: `How long does ${grape.name} age?`,
        a: grape.agingPotential
      }] : []),
      ...(grape.synonyms?.length > 0 ? [{
        q: `What are the synonyms for ${grape.name}?`,
        a: `${grape.name} is also known as ${grape.synonyms.join(', ')}.`
      }] : []),
      {
        q: `What wines are made from ${grape.name}?`,
        a: wines.slice(0, 5).map(w => w.name).join(', ') + (wines.length > 5 ? ' and more.' : '.')
      }
    ];

    const html = taxonomyHtml({
      title: grape.name,
      description: grape.description || '',
      metaDescription,
      pageUrl,
      itemType: 'DefinedTerm',
      faqs,
      wineList: wines,
      breadcrumb: [
        { name: 'Cellarion', item: SITE_URL },
        { name: `${grape.name} wines`, item: pageUrl }
      ]
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] grape error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/wine-types/:type
router.get('/wine-types/:type', ogLimiter, async (req, res) => {
  try {
    const type = String(req.params.type).toLowerCase();
    if (!WINE_TYPES.includes(type)) return res.status(404).send('Not found');

    const wines = await WineDefinition.find({ type, ...TAXONOMY_LISTED })
      .select('name producer slug _id')
      .sort({ name: 1 })
      .limit(20)
      .lean();

    if (wines.length < MIN_WINES) return res.status(404).send('Not found');

    const pageUrl = `${SITE_URL}/wines/type/${type}`;
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const metaDescription = `Explore ${typeLabel} wines tracked by Cellarion collectors. Browse producers and bottles from around the world.`;

    const html = taxonomyHtml({
      title: `${typeLabel} wines`,
      description: '',
      metaDescription,
      pageUrl,
      itemType: 'CollectionPage',
      faqs: [{
        q: `What are some notable ${typeLabel} wines?`,
        a: wines.slice(0, 5).map(w => w.name).join(', ') + (wines.length > 5 ? ' and more.' : '.')
      }],
      wineList: wines,
      breadcrumb: [
        { name: 'Cellarion', item: SITE_URL },
        { name: `${typeLabel} wines`, item: pageUrl }
      ]
    });

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] wine-type error:', err.message);
    res.status(500).send('Error generating page');
  }
});

module.exports = router;
