/**
 * Shared by the crawler-page suites (og.home, og.blog, og.taxonomy and
 * og.discussions .test.js): a throwaway server around the router, a stand-in
 * for a Mongoose query, and readers for the parts of a page the suites assert
 * on. Not a suite itself.
 */
const express = require('express');
const http = require('http');
const { CRAWLER_LANGUAGES } = require('../config/languages');

// The address the pages build their links from (SITE_URL in og/shared.js).
const SITE = process.env.FRONTEND_URL || 'https://cellarion.app';

/** Chainable like a Mongoose Query, awaitable to `value`. */
function mockQuery(value) {
  const q = {
    select: () => q, populate: () => q, sort: () => q, limit: () => q, maxTimeMS: () => q, lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
}

/**
 * Serve the router under /api/og on a free port. Resolves to
 * `{ get(path), close() }`; get answers `{ status, html, headers }` and does
 * not follow a redirect, so a suite can read where one points.
 */
function openPages(ogRouter) {
  const app = express();
  app.use('/api/og', ogRouter);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}/api/og`;
      resolve({
        async get(path) {
          const res = await fetch(base + path, { redirect: 'manual' });
          return { status: res.status, html: await res.text(), headers: res.headers };
        },
        close() {
          server.closeAllConnections();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/** Text as the pages escape it for HTML (esc in og/shared.js). */
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The page's one JSON-LD block, parsed. The block ends at the first
 * `</script>`, as it does for a browser: a value that broke out of the block
 * would cut the JSON short and fail the parse here.
 */
function jsonLd(html) {
  const blocks = html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [];
  if (blocks.length !== 1) throw new Error(`expected one JSON-LD block, found ${blocks.length}`);
  const text = blocks[0].replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '');
  return JSON.parse(text);
}

/** The entries of a JSON-LD `@graph`, by `@type` (a type list is joined with "+"). */
function graphByType(html) {
  const out = {};
  for (const node of jsonLd(html)['@graph']) {
    out[[].concat(node['@type']).join('+')] = node;
  }
  return out;
}

const canonical = (html) => (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1];
const metaDescription = (html) => (html.match(/<meta name="description" content="([^"]*)"/) || [])[1];

/** `[lang, href]` of every hreflang alternate on the page, in page order. */
function hreflangs(html) {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"/g)].map((m) => [m[1], m[2]]);
}

/** What hreflangs() must answer for a page at `pageUrl`. */
function expectedHreflangs(pageUrl) {
  return [...CRAWLER_LANGUAGES, 'x-default'].map((lang) => [lang, pageUrl]);
}

/**
 * The page as a snapshot keeps it: the site address replaced by {SITE} and the
 * hreflang lines left out, so a snapshot changes when the page's markup does,
 * not when the address or the list of languages does.
 */
function forSnapshot(html) {
  return html
    .split('\n')
    .filter((line) => !/<link rel="alternate" hreflang=/.test(line))
    .join('\n')
    .split(SITE)
    .join('{SITE}');
}

module.exports = {
  SITE, mockQuery, openPages, escHtml, jsonLd, graphByType, canonical, metaDescription,
  hreflangs, expectedHreflangs, forSnapshot,
};
