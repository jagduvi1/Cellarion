const express = require('express');
const helpContent = require('../data/helpContent');
const { CRAWLER_LANGUAGES } = require('../config/languages');
const { SITE_URL, esc, serializeJsonLd, hreflangLinks, ogLimiter } = require('./og/shared');

const router = express.Router();

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
// backend/src/data/helpContent.js, the server's copy of the Help page's text
// (kept section for section with the page; see that file). Nginx routes the
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
// GET /og/developers — the /developers page for crawlers: the guide and the
// API reference, both rendered from the OpenAPI document (openapi/crawlerPage).
router.get('/developers', ogLimiter, (req, res) => {
  try {
    const { developersPageHtml } = require('../openapi/crawlerPage');
    const { siteBaseUrl } = require('../utils/siteUrl');
    const { version } = require('../../package.json');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(developersPageHtml({ siteUrl: siteBaseUrl(), version }));
  } catch (err) {
    console.error('[og] developers page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

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
        text: `Customize, then Connectors, then + Add, then Add custom connector, and paste ${personalEndpoint}. Sign in with your Cellarion account and choose an access level.`,
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
        text: `A public endpoint at ${publicEndpoint} serves the shared wine registry (each wine with its grapes and region), similar wines and published guides to any AI, with no sign-up and no personal data.`,
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
    <p><a href="${esc(SITE_URL)}/connect-ai/claude">New to AI assistants? Start with the step-by-step guide for Claude</a></p>
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

// GET /og/connect-ai/claude — server-rendered twin of the beginner's guide to
// connecting Claude (frontend/src/pages/ConnectClaude.js), for crawlers and
// link previews. Same deliberate duplication as /connect-ai above: the copy
// mirrors the frontend's `connectClaude` locale block — keep them in step.
router.get('/connect-ai/claude', ogLimiter, (req, res) => {
  try {
    const pageUrl = `${SITE_URL}/connect-ai/claude`;
    const title = 'Ask Claude about your wine cellar';
    const metaDescription = 'Connect your Cellarion wine cellar to Claude in about five minutes, with a free Claude account. A step-by-step guide for beginners.';
    const intro = 'Cellar Chat is made for quick questions. Connect Cellarion to Claude and your whole cellar joins a full conversation: Claude can look through every bottle, count and compare, and, if you allow it, log what you drink and add new bottles for you.';
    const personalEndpoint = `${SITE_URL}/api/mcp`;

    const steps = [
      { title: 'Get a Claude account', text: 'Go to claude.ai and sign up for free, or sign in if you already have an account. The free plan lets you add one connector of your own, and Cellarion is the only one you need.' },
      { title: 'Add Cellarion to Claude', text: `In Claude, open Customize, then Connectors, click + Add and choose Add custom connector. Name it Cellarion, paste ${personalEndpoint} and click Add.` },
      { title: 'Sign in and choose what Claude may do', text: 'Claude takes you to a Cellarion page. Sign in, pick an access level (Read only, Read + log drinking, or Full access) and click Approve.' },
      { title: 'Start chatting', text: 'Open a new chat in Claude and ask about your cellar. A connector added on the web or desktop works in the Claude phone app too.' },
    ];
    const faq = [
      { q: 'Does it cost anything?', a: 'Not from Cellarion: the connector is free. Claude\'s free plan is enough.' },
      { q: 'What does Claude see?', a: 'Your own Cellarion data: your cellars, bottles, ratings, notes and racks, and also things like your wishlist, journal, profile, settings, notifications and support tickets. Never other members\' private data.' },
      { q: 'What if Claude gets something wrong?', a: 'Changes Claude makes to your bottles, racks and cellars are listed in Cellarion under Settings, AI & connections, Recent AI activity, where you can undo recent ones.' },
      { q: 'How do I disconnect?', a: 'In Cellarion, open Settings, AI & connections, API tokens and click Revoke next to Claude (AI).' },
    ];

    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'HowTo',
          name: title,
          description: intro,
          url: pageUrl,
          step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.title, text: s.text })),
        },
        {
          '@type': 'FAQPage',
          mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Cellarion', item: SITE_URL },
            { '@type': 'ListItem', position: 2, name: 'Connect your AI to your wine cellar', item: `${SITE_URL}/connect-ai` },
            { '@type': 'ListItem', position: 3, name: title, item: pageUrl },
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
  <nav><a href="${esc(SITE_URL)}">Cellarion</a> / <a href="${esc(SITE_URL)}/connect-ai">Connect your AI</a> / ${esc(title)}</nav>
  <header>
    <h1>${esc(title)}</h1>
    <p>${esc(intro)}</p>
  </header>
  <main>
    <section>
      <h2>Set it up in four steps</h2>
      <ol>
        ${steps.map(s => `<li><strong>${esc(s.title)}</strong> — ${esc(s.text)}</li>`).join('\n        ')}
      </ol>
    </section>
    <section>
      <h2>Good to know</h2>
      ${faq.map(f => `<h3>${esc(f.q)}</h3><p>${esc(f.a)}</p>`).join('\n      ')}
    </section>
    <p><a href="${esc(SITE_URL)}/connect-ai">Set-up for other AI apps, and the technical details</a></p>
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
    console.error('[og] connect-ai/claude page error:', err.message);
    res.status(500).send('Error generating page');
  }
});

// A registry wine.
router.use(require('./og/wine'));

// The blog index and a post.
router.use(require('./og/blog'));

// A region, a country, a grape, a wine type.
router.use(require('./og/taxonomy'));

// The forum list and a thread.
router.use(require('./og/discussions'));

module.exports = router;
