const express = require('express');
const rateLimit = require('express-rate-limit');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const BlogPost = require('../models/BlogPost');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const helpContent = require('../data/helpContent');
const { fromNormalized } = require('../utils/ratingUtils');
const { isValidId } = require('../utils/validation');
const { sanitizeForumHtml, sanitizeBlogHtml, extractFaqFromHtml, extractHowToFromHtml } = require('../utils/sanitizeHtml');
const { stripHtml } = require('../utils/sanitize');
const { rateLimitKey } = require('../utils/clientIp');
const { CRAWLER_LANGUAGES } = require('../config/languages');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MIN_WINES = 3;

/**
 * Serialize a JSON-LD object for safe embedding inside a <script
 * type="application/ld+json"> block. JSON.stringify does NOT escape `<`/`>`/`&`,
 * so a user-controlled field containing `</script>` (e.g. a wine name) could
 * otherwise break out of the script element. Escaping these as \uXXXX keeps the
 * JSON valid and the parsed data intact while making breakout impossible. (The
 * global CSP already blocks inline-script execution; this is defense-in-depth +
 * correct structured data for non-CSP crawlers.)
 */
function serializeJsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/**
 * hreflang alternates for a crawler-rendered page. One entry per language the
 * site is offered in, plus x-default. Both this and the SPA's SEOHead advertise
 * the same finished languages — they previously disagreed, with this side
 * omitting Swedish entirely.
 */
function hreflangLinks(pageUrl) {
  return [...CRAWLER_LANGUAGES, 'x-default']
    .map((lang) => `  <link rel="alternate" hreflang="${lang}" href="${esc(pageUrl)}" />`)
    .join('\n');
}

const router = express.Router();

const ogLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  // Key on the masked client IP (security audit L-10): the default keyGenerator
  // uses the raw req.ip, so an IPv6 client could rotate the low 64 bits of its
  // /64 for an unbounded number of (uncached, DB-hitting) OG renders. rateLimitKey
  // collapses IPv6 to its /64 and honours the CF-Connecting-IP trust model.
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false
});

const SITE_URL = process.env.FRONTEND_URL || 'https://cellarion.app';
const API_URL = process.env.BACKEND_URL || process.env.FRONTEND_URL || 'https://cellarion.app';

// ── Landing-page copy ────────────────────────────────────────────────────────
// Mirrors the marketing copy in frontend/src/locales/en/translation.json under
// the `landing.*` keys. The backend Docker image does NOT bundle the frontend
// locale files, so the crawler-facing copy is duplicated here. The bare "/" is
// the page AI engines and search bots judge first — without this they'd get the
// empty SPA shell (no schema, no FAQ, no prose). Keep this in sync with the SPA:
// if you change the landing copy or FAQ in translation.json, update it here too.
const LANDING = {
  metaTitle: 'Cellarion — Wine Cellar App | Track Your Wine Collection Online',
  metaDescription: 'Track your wine collection with Cellarion. Log every bottle, visualise racks, get drink-window alerts, and share cellars with friends. Free wine cellar app at cellarion.app.',
  heroHeadline: 'Your wine cellar, beautifully organised.',
  heroSubline: 'The modern way to track your wine collection. Log every bottle, visualise your racks, get drink-window alerts at the perfect moment, and share cellars with friends — all in one private, ad-free app.',
  aboutTitle: 'What is Cellarion?',
  aboutText: 'Cellarion is a wine cellar management app for collectors, restaurants, and weekend enthusiasts. Track every bottle in your collection — vintage, producer, region, price, personal rating, and tasting notes. Organise wines across cellars and racks, get drink-window alerts so you never miss a wine\'s peak, and share cellars with friends. Free to use at cellarion.app.',
  featuresTitle: 'Everything your cellar needs',
  features: [
    ['Bottle Tracking', 'Log every bottle in your collection — vintage, producer, region, price, personal rating, and tasting notes, all in one place.'],
    ['Cellar & Rack Management', 'Organize bottles across multiple cellars and visualize your physical racks on an interactive grid. Know exactly where each bottle lives.'],
    ['Drink Window Alerts', 'Get notified when a bottle is approaching its peak or past it. Never open a great wine too early — or too late.'],
    ['Rich Statistics', 'Explore your cellar with charts and maps — breakdown by country, grape, value, drink status, and more.'],
    ['Smart Wine Search', 'Fuzzy matching and deduplication so you always find the right wine, even with a typo.'],
    ['Share Your Cellar', 'Invite friends or colleagues to browse or co-manage a cellar. Granular role-based access keeps you in control.'],
    ['Label Scanning', 'Snap a photo of the label and we\'ll fill in the details. Background removal keeps bottle images clean and beautiful.'],
    ['Import & Export', 'Bring your existing collection in via CSV. A structured wine registry shared across users ensures clean, consistent data.'],
  ],
  whyTitle: 'Why wine lovers choose Cellarion',
  why: [
    ['Free to use', 'All core features are free at cellarion.app — no credit card, no trial, no upsell pop-ups. We don\'t sell ads either.'],
    ['No lock-in', 'Your collection is yours. Export everything as JSON — or a ZIP with your images — with one click, any time. If you ever leave, you walk out with all your data.'],
    ['Private by design', 'No third-party trackers, no data sold to wine merchants. Just a clean app that stays out of your way.'],
    ['GDPR-compliant', 'Hosted on European infrastructure. Full data export, account deletion, and a one-click email opt-out built in from day one.'],
  ],
  // Visible Q&A below MUST match this FAQ verbatim — the rendered page shows
  // exactly these pairs, so the FAQPage JSON-LD and visible text never diverge.
  faqs: [
    ['What is Cellarion?', 'Cellarion is a wine cellar management app that helps you track every bottle in your collection. Log vintage, producer, region, price, personal rating, and tasting notes; organise bottles across cellars and racks; get drink-window alerts when wines approach their peak; and share cellars with friends or co-managers. It\'s free to use at cellarion.app.'],
    ['How do I track my wine collection with Cellarion?', 'You log each bottle with its vintage, producer, region, price, personal rating, and tasting notes. Bottles live inside named cellars and can be placed on customisable racks for visual organisation. Cellarion automatically calculates drink windows, tracks consumption history, and gives you statistics across your whole collection.'],
    ['What is a drink window in wine?', 'A drink window is the period during which a wine is at its best — typically a range of years bracketing the wine\'s peak maturity. Cellarion classifies every vintage as Not Ready, Early, Peak, Late, or Declining based on producer notes and vintage data, so you know which bottles to drink soon and which to keep cellaring.'],
    ['Is Cellarion really free?', 'Yes. All core features at cellarion.app are free — track unlimited bottles, organise cellars, get drink-window alerts, share with friends, and export your data anytime. There are no credit-card prompts, no premium tiers gating basic functionality, and we don\'t sell ads or your data.'],
    ['How do I import wines from Vivino or CellarTracker?', 'Cellarion supports CSV import. Export your collection from Vivino, CellarTracker, or any spreadsheet, then upload the CSV in Cellarion\'s import tool. The shared wine registry deduplicates entries automatically so your data stays clean and consistent across the whole catalogue.'],
    ['Can I export my data and leave any time?', 'Yes — your data is yours. Cellarion includes a one-click data export that gives you everything as JSON (or a ZIP including your uploaded images), plus CSV import for bottles. You can delete your account from Settings with a 7-day cooling-off window. Hosted data lives on European infrastructure under GDPR.'],
  ],
};

// GET /og/home — Server-rendered landing page for crawlers. Nginx routes the
// bare "/" for crawler user-agents here so AI engines and search bots see the
// full pitch, FAQ, and JSON-LD (WebSite + Organization + SoftwareApplication +
// FAQPage) instead of the empty SPA shell. Real users still get the SPA.
router.get('/home', ogLimiter, (req, res) => {
  try {
    const pageUrl = `${SITE_URL}/`;
    const logo = `${SITE_URL}/cellarion-logo.jpg`;

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${SITE_URL}/#website`,
          url: SITE_URL,
          name: 'Cellarion',
          description: LANDING.metaDescription,
          inLanguage: CRAWLER_LANGUAGES,
        },
        {
          '@type': 'Organization',
          '@id': `${SITE_URL}/#organization`,
          name: 'Cellarion',
          url: SITE_URL,
          logo,
          // Off-site profiles that corroborate the entity for search / LLMs.
          // Add new owned profiles here as they go live (directories, socials).
          sameAs: [
            'https://github.com/jagduvi1/Cellarion',
            'https://play.google.com/store/apps/details?id=app.cellarion.twa',
          ],
        },
        {
          '@type': 'SoftwareApplication',
          '@id': `${SITE_URL}/#app`,
          name: 'Cellarion',
          description: LANDING.metaDescription,
          applicationCategory: 'LifestyleApplication',
          operatingSystem: 'Web, Android',
          url: SITE_URL,
          downloadUrl: 'https://play.google.com/store/apps/details?id=app.cellarion.twa',
          // High-signal entity field for LLMs/Google — reuses the visible feature
          // names so the structured data never diverges from the page copy.
          featureList: LANDING.features.map(([title]) => title),
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        },
        {
          '@type': 'FAQPage',
          '@id': `${SITE_URL}/#faq`,
          mainEntity: LANDING.faqs.map(([q, a]) => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: a },
          })),
        },
      ],
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(LANDING.metaTitle)}</title>
  <meta name="description" content="${esc(LANDING.metaDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(LANDING.metaTitle)}" />
  <meta property="og:description" content="${esc(LANDING.metaDescription)}" />
  <meta property="og:image" content="${esc(logo)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(LANDING.metaTitle)}" />
  <meta name="twitter:description" content="${esc(LANDING.metaDescription)}" />
  <meta name="twitter:image" content="${esc(logo)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
${hreflangLinks(pageUrl)}
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <header>
    <h1>${esc(LANDING.heroHeadline)}</h1>
    <p>${esc(LANDING.heroSubline)}</p>
  </header>
  <main>
    <section>
      <h2>${esc(LANDING.aboutTitle)}</h2>
      <p>${esc(LANDING.aboutText)}</p>
    </section>
    <section>
      <h2>${esc(LANDING.featuresTitle)}</h2>
      ${LANDING.features.map(([title, desc]) => `<h3>${esc(title)}</h3><p>${esc(desc)}</p>`).join('\n      ')}
    </section>
    <section>
      <h2>${esc(LANDING.whyTitle)}</h2>
      ${LANDING.why.map(([title, desc]) => `<h3>${esc(title)}</h3><p>${esc(desc)}</p>`).join('\n      ')}
    </section>
    <section>
      <h2>Frequently asked questions</h2>
      ${LANDING.faqs.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n      ')}
    </section>
  </main>
  <footer>
    <p>Get started free at <a href="${esc(pageUrl)}">Cellarion</a> — track your wine collection, get drink-window alerts, and share cellars with friends. <a href="https://github.com/jagduvi1/Cellarion">Open source on GitHub</a>.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] home page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/help — Server-rendered help & guide page for crawlers. Built from
// backend/src/data/helpContent.js (the single source of truth shared with the
// help AI), so it stays in sync without duplicating copy. Nginx routes the
// "/help" SPA route for crawler user-agents here.
router.get('/help', ogLimiter, (req, res) => {
  try {
    const pageUrl = `${SITE_URL}/help`;
    const title = 'Help & Guide';
    const metaDescription = 'How to use Cellarion: managing cellars and bottles, label scanning, sharing, racks, drink-window recommendations, import/export, and more.';
    const sections = helpContent.sections || [];

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'FAQPage',
          mainEntity: sections.map(s => ({
            '@type': 'Question',
            name: s.title,
            acceptedAnswer: {
              '@type': 'Answer',
              text: (s.details && s.details.length > 0) ? s.details.join(' ') : s.summary,
            },
          })),
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
  <title>${esc(title)} — Cellarion</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)} — Cellarion" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  <meta property="og:image" content="${esc(SITE_URL)}/cellarion-logo.jpg" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)} — Cellarion" />
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
    ${sections.map(s => `<section><h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p>${
      (s.details && s.details.length > 0) ? `<ul>${s.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''
    }</section>`).join('\n    ')}
  </main>
  <footer>
    <p><a href="${esc(SITE_URL)}">Cellarion</a> — track your wine collection, get drink-window alerts, and share cellars with friends.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] help page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// GET /og/connect-ai — server-rendered MCP set-up page for crawlers.
//
// This one matters more than a normal OG page: AI crawlers are exactly the
// audience that should learn this instance HAS an MCP server, so the endpoints
// are rendered as literal text rather than hidden behind client-side JS. The
// copy is deliberately duplicated from the frontend's `connectAi` locale block
// (short, stable, and the backend has no access to frontend locales) — keep the
// two in sync when either changes.
router.get('/connect-ai', ogLimiter, (req, res) => {
  try {
    const pageUrl = `${SITE_URL}/connect-ai`;
    const title = 'Connect your AI to your wine cellar';
    const metaDescription = 'Cellarion speaks the Model Context Protocol. Connect Claude, ChatGPT, VS Code, Cursor, Gemini CLI or any MCP client to your wine cellar.';
    const personalEndpoint = `${SITE_URL}/api/mcp`;
    const publicEndpoint = `${SITE_URL}/api/mcp/public`;

    const steps = [
      {
        title: 'Claude (web, desktop and mobile)',
        text: `Settings, then Connectors, then Add custom connector, and paste ${personalEndpoint}. Sign in with your Cellarion account and choose an access level.`,
      },
      {
        title: 'ChatGPT',
        text: `Settings, then Connectors, then Advanced, enable Developer mode, choose Create and paste ${personalEndpoint} with authentication set to OAuth.`,
      },
      {
        title: 'Claude Code',
        text: `Run: claude mcp add --transport http cellarion ${personalEndpoint}`,
      },
      {
        title: 'VS Code, Cursor and Windsurf',
        text: `Add ${personalEndpoint} as an HTTP MCP server in mcp.json.`,
      },
      {
        title: 'Gemini CLI',
        text: `Add ${personalEndpoint} as an httpUrl MCP server in ~/.gemini/settings.json.`,
      },
      {
        title: 'Claude Desktop, LM Studio and other stdio clients',
        text: 'Run the published bridge with: npx -y cellarion-mcp, setting CELLARION_TOKEN to a personal API token from Settings, then API tokens.',
      },
      {
        title: 'No account needed',
        text: `A public endpoint at ${publicEndpoint} serves the shared wine registry, grape and region profiles, sommelier drink windows and published guides to any AI, with no sign-up and no personal data.`,
      },
    ];

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'HowTo',
          name: title,
          description: metaDescription,
          url: pageUrl,
          step: steps.map((s, i) => ({
            '@type': 'HowToStep',
            position: i + 1,
            name: s.title,
            text: s.text,
          })),
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
  <title>${esc(title)} — Cellarion</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(title)} — Cellarion" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  <meta property="og:image" content="${esc(SITE_URL)}/cellarion-logo.jpg" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)} — Cellarion" />
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
    <section>
      <h2>Endpoints</h2>
      <ul>
        <li>Personal (your own cellar, requires sign-in): ${esc(personalEndpoint)} — Streamable HTTP, OAuth 2.1 with PKCE, or a personal bearer token.</li>
        <li>Public (shared wine reference, no account): ${esc(publicEndpoint)} — Streamable HTTP, no authentication, read-only.</li>
        <li>Discovery: ${esc(SITE_URL)}/.well-known/oauth-protected-resource/api/mcp</li>
      </ul>
    </section>
    ${steps.map(s => `<section><h2>${esc(s.title)}</h2><p>${esc(s.text)}</p></section>`).join('\n    ')}
  </main>
  <footer>
    <p><a href="${esc(SITE_URL)}">Cellarion</a> — track your wine collection, get drink-window alerts, and share cellars with friends. Open source, AGPL-3.0.</p>
  </footer>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(html);
  } catch (err) {
    console.error('[og] connect-ai page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

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
    const filter = isId
      ? { _id: idOrSlug, nonWine: { $ne: true } }
      : { slug: String(idOrSlug).toLowerCase(), nonWine: { $ne: true } };

    const wine = await WineDefinition.findOne(filter)
      .populate(['country', 'region', 'grapes'])
      .select('name producer slug country region appellation classification grapes type image communityRating')
      .lean();

    if (!wine) {
      return res.status(404).send('Not found');
    }

    // Canonicalise to slug URL when one exists. 301 means crawlers + browsers
    // both follow and any link equity earned by the ObjectId URL transfers.
    if (isId && wine.slug) {
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
    // Keep meta description under 160 chars
    const fullDesc = `${fullTitle}. ${details}. Discover, track, and manage your wine cellar with Cellarion.`;
    const description = fullDesc.length > 160 ? fullDesc.slice(0, 157) + '...' : fullDesc;
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

    // Pull the most authoritative vintage profile so we can include real drink-window
    // dates in the prose and FAQ. Prefer reviewed profiles, then most recent vintage.
    // Relative (NV) profiles are excluded outright: they store year-OFFSETS from each
    // bottle's purchase, and this page has no bottle to anchor them to — quoting them
    // would print "peak maturity from 2 to 5" as if those were dates. The byte-wise
    // vintage sort makes it worse ('NV' > every year string), so without the filter a
    // reviewed NV profile would WIN the pick whenever one exists (audit 2026-08-10).
    let profile = null;
    try {
      profile = await WineVintageProfile.findOne({
        wineDefinition: wine._id,
        status: 'reviewed',
        relative: { $ne: true }
      }).sort({ vintage: -1 }).select('vintage peakFrom peakUntil earlyFrom earlyUntil lateFrom lateUntil').lean();
    } catch (e) {
      // Profile is optional — failure here shouldn't break the page render.
    }
    const peakFrom = profile?.peakFrom;
    const peakUntil = profile?.peakUntil;
    const peakKnown = peakFrom && peakUntil;

    // Generate a prose paragraph (template, not LLM) — AI engines extract from prose,
    // not from key-value lists. ~80–150 words including drink-window text when known.
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
    const drinkPhrase = peakKnown
      ? (profile.vintage
          ? ` The ${profile.vintage} vintage is at peak maturity from ${peakFrom} to ${peakUntil}.`
          : ` Peak maturity is from ${peakFrom} to ${peakUntil}.`)
      : '';
    const ratingPhrase = hasRating
      ? ` Cellarion users rate it ${fromNormalized(wine.communityRating.averageNormalized, '5').toFixed(1)} out of 5 across ${wine.communityRating.reviewCount} ${wine.communityRating.reviewCount === 1 ? 'review' : 'reviews'}.`
      : '';
    const proseParagraph = `${wine.name} is a ${typeWord} produced by ${wine.producer}${placeWords ? ` in ${placeWords}` : ''}.${classificationPhrase} ${grapesPhrase}${drinkPhrase}${ratingPhrase} Track this wine and manage your cellar with Cellarion — the free, open-source wine app at cellarion.app.`.replace(/\s+/g, ' ').trim();

    // Per-wine FAQ — only emit a question when the underlying data exists. AI engines
    // love quoting Q&A pairs verbatim; this is what shows up in chat answers.
    const faqs = [];
    if (peakKnown) {
      faqs.push({
        q: `When should I drink ${wine.name}?`,
        a: `${wine.name}${profile.vintage ? ` ${profile.vintage}` : ''} reaches peak maturity between ${peakFrom} and ${peakUntil}. Outside that window, expect either underdeveloped tannins (too early) or fading fruit (too late).`
      });
    }
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
    ${wine.region?.name ? `<p><strong>Region:</strong> ${esc(wine.region.name)}</p>` : ''}
    ${wine.country?.name ? `<p><strong>Country:</strong> ${esc(wine.country.name)}</p>` : ''}
    ${grapeNames.length > 0 ? `<p><strong>Grapes:</strong> ${esc(grapeNames.join(', '))}</p>` : ''}
    ${peakKnown ? `<p><strong>Drink window:</strong> ${peakFrom}–${peakUntil}${profile.vintage ? ` (${esc(profile.vintage)} vintage)` : ''}</p>` : ''}
    ${hasRating && ratingOn5 != null ? `<p><strong>Community rating:</strong> ${ratingOn5.toFixed(1)}/5 from ${wine.communityRating.reviewCount} ${wine.communityRating.reviewCount === 1 ? 'review' : 'reviews'}</p>` : ''}
    ${wine.image ? `<img src="${esc(imageUrl)}" alt="${esc(wine.name)}" width="300" />` : ''}
    ${faqs.length > 0 ? `<section><h2>Frequently asked questions</h2>${faqs.map(({ q, a }) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('')}</section>` : ''}
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

// ── Shared taxonomy renderer ─────────────────────────────────────────────────
// Used by the three taxonomy handlers below. Builds a CollectionPage with
// ItemList JSON-LD and a prose description, suitable for regions, countries,
// and grapes.

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

    const wines = await WineDefinition.find({ region: region._id, nonWine: { $ne: true } })
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

    const wines = await WineDefinition.find({ country: country._id, nonWine: { $ne: true } })
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

    const wines = await WineDefinition.find({ grapes: grape._id, nonWine: { $ne: true } })
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

    const wines = await WineDefinition.find({ type, nonWine: { $ne: true } })
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

// Escape HTML entities for safe embedding in HTML attributes
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = router;
