/**
 * GET /api/openapi.json — the public API contract (openapi/document.js) for
 * THIS server's version, so a self-hosted server describes what it really
 * offers. Public, read-only and readable cross-origin, for OpenAPI tools and
 * the /developers page. No token; nothing personal in it.
 */
const express = require('express');
const { version } = require('../../package.json');
const { buildOpenApiDocument } = require('../openapi/document');
const { siteBaseUrl } = require('../utils/siteUrl');

const router = express.Router();

let cached = null;
function document() {
  if (!cached) cached = JSON.stringify(buildOpenApiDocument({ version, serverUrl: siteBaseUrl() }));
  return cached;
}

router.get('/', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/json').send(document());
});

module.exports = router;
