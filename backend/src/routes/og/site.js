// The crawler-rendered site pages: the front page (in English and in each
// front-page language), Help, Developers and the two "connect your AI" pages.
// None reads the database. Mounted by routes/og.js.

const express = require('express');
const helpContent = require('../../data/helpContent');
const { CRAWLER_LANGUAGES, FRONT_PAGE_LANGUAGES } = require('../../config/languages');
const { SITE_URL, esc, serializeJsonLd, ogLimiter } = require('./shared');

const router = express.Router();

// ── Front page ───────────────────────────────────────────────────────────────
// The front page as crawlers get it, in English at "/" and in each of
// FRONT_PAGE_LANGUAGES at its own address (such as /fr): the same text the app's
// landing page shows there, so the page a search engine judges is the page a
// visitor reads. The text is the `landing` keys of the app's locale files,
// copied into data/landingCopy.json by scripts/sync-landing-copy.mjs, because
// the backend image does not bundle the frontend locales.
const LANDING_COPY = require('../../data/landingCopy.json');

// The cards in the order the app's landing page shows them (pages/LandingPage.js):
// each name is the middle of a landing.feature<Name>Title / …Desc pair, and of
// a landing.why<Name>Title / …Desc pair.
const FEATURES = ['Bottle', 'Cellar', 'Drink', 'Stats', 'Search', 'Share', 'Label', 'Import'];
const REASONS = ['Free', 'Export', 'Privacy', 'Gdpr'];

const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=app.cellarion.twa';
const SOURCE_URL = 'https://github.com/jagduvi1/Cellarion';

const frontPageUrl = (lang) => (lang === 'en' ? `${SITE_URL}/` : `${SITE_URL}/${lang}`);

/** The front page's language versions as [hreflang, address]: English is x-default. */
const FRONT_PAGE_ALTERNATES = [
  ['en', frontPageUrl('en')],
  ...FRONT_PAGE_LANGUAGES.map((lang) => [lang, frontPageUrl(lang)]),
  ['x-default', frontPageUrl('en')],
];

/**
 * The front page's text in `lang`. A key the translation leaves empty reads in
 * English, as it does in the app (fallbackLng).
 */
function landingText(lang) {
  const read = (copy, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), copy);
  const text = (key) => {
    const own = read(LANDING_COPY[lang], key);
    return typeof own === 'string' && own.trim() !== '' ? own : read(LANDING_COPY.en, key);
  };
  const faqNumbers = Object.keys(LANDING_COPY.en.faq)
    .map((key) => /^q(\d+)$/.exec(key)?.[1])
    .filter(Boolean)
    .sort((a, b) => a - b);
  return {
    text,
    features: FEATURES.map((name) => [text(`feature${name}Title`), text(`feature${name}Desc`)]),
    reasons: REASONS.map((name) => [text(`why${name}Title`), text(`why${name}Desc`)]),
    faqs: faqNumbers.map((n) => [text(`faq.q${n}`), text(`faq.a${n}`)]),
  };
}

function frontPageHtml(lang) {
  const { text, features, reasons, faqs } = landingText(lang);
  const pageUrl = frontPageUrl(lang);
  const logo = `${SITE_URL}/cellarion-logo.jpg`;
  const metaTitle = text('metaTitle');
  const metaDescription = text('metaDescription');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: SITE_URL,
        name: 'Cellarion',
        description: metaDescription,
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
        sameAs: [SOURCE_URL, PLAY_STORE_URL],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: 'Cellarion',
        description: metaDescription,
        applicationCategory: 'LifestyleApplication',
        operatingSystem: 'Web, Android',
        url: SITE_URL,
        downloadUrl: PLAY_STORE_URL,
        // High-signal entity field for LLMs/Google — reuses the visible feature
        // names so the structured data never diverges from the page copy.
        featureList: features.map(([title]) => title),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'FAQPage',
        '@id': `${pageUrl}#faq`,
        inLanguage: lang,
        // The visible Q&A below prints exactly these pairs, so the FAQPage
        // JSON-LD and the text a reader sees never diverge.
        mainEntity: faqs.map(([q, a]) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  };

  const cards = (list) => list.map(([title, desc]) => `<h3>${esc(title)}</h3><p>${esc(desc)}</p>`).join('\n      ');
  const alternates = FRONT_PAGE_ALTERNATES
    .map(([hreflang, href]) => `  <link rel="alternate" hreflang="${hreflang}" href="${esc(href)}" />`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8" />
  <title>${esc(metaTitle)}</title>
  <meta name="description" content="${esc(metaDescription)}" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${esc(metaTitle)}" />
  <meta property="og:description" content="${esc(metaDescription)}" />
  <meta property="og:image" content="${esc(logo)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(metaTitle)}" />
  <meta name="twitter:description" content="${esc(metaDescription)}" />
  <meta name="twitter:image" content="${esc(logo)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
${alternates}
  <script type="application/ld+json">${serializeJsonLd(jsonLd)}</script>
</head>
<body>
  <header>
    <h1>${esc(`${text('heroHeadline')} ${text('heroAccent')}`)}</h1>
    <p>${esc(text('heroSubline'))}</p>
  </header>
  <main>
    <section>
      <h2>${esc(text('aboutTitle'))}</h2>
      <p>${esc(text('aboutText'))}</p>
    </section>
    <section>
      <h2>${esc(text('featuresTitle'))}</h2>
      <p>${esc(text('featuresSub'))}</p>
      ${cards(features)}
    </section>
    <section>
      <h2>${esc(text('whyTitle'))}</h2>
      <p>${esc(text('whySub'))}</p>
      ${cards(reasons)}
    </section>
    <section>
      <h2>${esc(text('faqTitle'))}</h2>
      <p>${esc(text('faqSub'))}</p>
      ${cards(faqs)}
    </section>
    <section>
      <h2>${esc(text('finalTitle'))}</h2>
      <p>${esc(text('finalSub'))}</p>
      <p><a href="${esc(`${SITE_URL}/login?mode=register`)}">${esc(text('createAccount'))}</a></p>
    </section>
  </main>
  <footer>
    <p><a href="${esc(SOURCE_URL)}">${esc(text('footerSourceLink'))}</a></p>
  </footer>
</body>
</html>`;
}

function sendFrontPage(res, lang) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(frontPageHtml(lang));
}

// GET /og/home — the English front page. Nginx routes the bare "/" for crawler
// user-agents here so AI engines and search bots see the full pitch, FAQ, and
// JSON-LD (WebSite + Organization + SoftwareApplication + FAQPage) instead of
// the empty SPA shell. Real users still get the SPA.
router.get('/home', ogLimiter, (req, res) => sendFrontPage(res, 'en'));

// GET /og/home/:lang — the front page at /fr, /de, /nb, /sv, routed here for crawlers by
// the nginx location for FRONT_PAGE_LANGUAGES. English has no second address.
router.get('/home/:lang', ogLimiter, (req, res) => {
  if (!FRONT_PAGE_LANGUAGES.includes(req.params.lang)) return res.status(404).send('Not found');
  return sendFrontPage(res, req.params.lang);
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

// GET /og/developers — the /developers page for crawlers: the guide and the
// API reference, both rendered from the OpenAPI document (openapi/crawlerPage).
router.get('/developers', ogLimiter, (req, res) => {
  try {
    const { developersPageHtml } = require('../../openapi/crawlerPage');
    const { siteBaseUrl } = require('../../utils/siteUrl');
    const { version } = require('../../../package.json');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(developersPageHtml({ siteUrl: siteBaseUrl(), version }));
  } catch (err) {
    console.error('[og] developers page error:', err.message);
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

module.exports = router;
