/**
 * The server-rendered /developers page for crawlers and link previews
 * (routes/og.js → GET /api/og/developers; nginx sends bots there). People get
 * the SPA page, where Redoc renders the same OpenAPI document. Both read one
 * source: the guide is the document's info.description and the reference is
 * its operations, so the crawler copy cannot drift from the page.
 */
const { marked } = require('marked');
const { buildOpenApiDocument } = require('./document');

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Our own Markdown (the guide and the operation descriptions) — trusted text,
// rendered as GitHub-flavoured Markdown with tables.
const md = (text) => marked.parse(String(text || ''), { gfm: true, async: false });

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function scopeOf(op) {
  const req = (op.security || []).map((s) => s.apiToken).filter(Boolean);
  if (!req.length) return 'No token needed';
  const scopes = req.flat();
  return scopes.length ? `Token scope: ${scopes.join(', ')}` : 'Any personal API token';
}

function exampleOf(op) {
  for (const status of ['200', '202']) {
    const r = op.responses[status];
    const ex = r && r.content && r.content['application/json'] && r.content['application/json'].example;
    if (ex !== undefined) return JSON.stringify(ex, null, 2);
  }
  return null;
}

function operationsHtml(doc) {
  const byTag = new Map(doc.tags.map((t) => [t.name, { tag: t, ops: [] }]));
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (op) byTag.get(op.tags[0]).ops.push({ method: method.toUpperCase(), path, op });
    }
  }
  return [...byTag.values()].filter((g) => g.ops.length).map(({ tag, ops }) => `
    <section>
      <h2>${esc(tag.name)}</h2>
      <p>${esc(tag.description)}</p>
      ${ops.map(({ method, path, op }) => {
    const example = exampleOf(op);
    const params = (op.parameters || []).map((p) => (p.$ref ? doc.components.parameters[p.$ref.split('/').pop()] : p));
    return `<article id="${esc(op.operationId)}">
        <h3><code>${esc(method)} ${esc(path)}</code> — ${esc(op.summary)}</h3>
        <p>${esc(scopeOf(op))}</p>
        ${op.description ? md(op.description) : ''}
        ${params.length ? `<ul>${params.map((p) => `<li><code>${esc(p.name)}</code> (${esc(p.in)}${p.required ? ', required' : ''})${p.description ? `: ${esc(p.description)}` : ''}</li>`).join('')}</ul>` : ''}
        ${example ? `<pre><code>${esc(example)}</code></pre>` : ''}
      </article>`;
  }).join('\n      ')}
    </section>`).join('\n');
}

/** The whole page for one server. */
function developersPageHtml({ siteUrl, version }) {
  const doc = buildOpenApiDocument({ version, serverUrl: siteUrl });
  const pageUrl = `${siteUrl}/developers`;
  const title = 'Cellarion API: developer guide and reference';
  const description = 'Build on your own Cellarion wine cellar data: a stable REST API with personal API tokens, a one-call inventory with ETag caching, live update events, and an OpenAPI 3.1 reference.';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        headline: title,
        description,
        url: pageUrl,
        inLanguage: 'en',
        about: { '@type': 'WebAPI', name: 'Cellarion API', documentation: pageUrl, url: `${siteUrl}/api/openapi.json` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Cellarion', item: siteUrl },
          { '@type': 'ListItem', position: 2, name: 'Developers', item: pageUrl },
        ],
      },
    ],
  };
  // JSON-LD inside <script>: no "</" may end it early.
  const ld = JSON.stringify(jsonLd).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)} — Cellarion</title>
  <meta name="description" content="${esc(description)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(title)} — Cellarion" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(siteUrl)}/cellarion-logo.jpg" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:site_name" content="Cellarion" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <link rel="alternate" type="application/json" href="${esc(siteUrl)}/api/openapi.json" title="OpenAPI 3.1 document" />
  <script type="application/ld+json">${ld}</script>
</head>
<body>
  <nav><a href="${esc(siteUrl)}">Cellarion</a> / Developers</nav>
  <header>
    <h1>Cellarion API</h1>
    <p>${esc(doc.info.summary)} Version ${esc(doc.info.version)}. <a href="${esc(siteUrl)}/api/openapi.json">Download the OpenAPI 3.1 document</a>.</p>
  </header>
  <main>
    <section id="guide">
      ${md(doc.info.description)}
    </section>
    ${operationsHtml(doc)}
  </main>
  <footer>
    <p><a href="${esc(siteUrl)}">Cellarion</a>: track your wine collection, get drink-window alerts, and share cellars with friends. Open source, AGPL-3.0.</p>
  </footer>
</body>
</html>`;
}

module.exports = { developersPageHtml };
