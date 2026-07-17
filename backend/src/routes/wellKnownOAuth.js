const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { authServerMetadata, protectedResourceMetadata } = require('../services/mcpOAuth');
const { rateLimitKey } = require('../utils/clientIp');

// OAuth discovery documents for the MCP connector flow. These MUST live at the
// issuer origin's /.well-known/ (RFC 8414 + RFC 9728), so this router is mounted
// at the app ROOT, before the API rate limiters — discovery must never be
// throttled for a real client. Public, unauthenticated, cacheable-ish.
//
// The dedicated limiter below is deliberately GENEROUS: a legitimate client
// fetches discovery once per connect flow (and the 1h Cache-Control keeps
// repeats away), so 300/15min per IP never touches real traffic — it only
// bounds a hammering loop on the un-apiLimited root path.
//
// ⚠️ PROD: the frontend nginx must proxy these two paths to the backend (they
// are at the origin root, not under /api). See docs/mcp-oauth.md.

const discoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(discoveryLimiter);

function sendMeta(res, body) {
  // Discovery is fetched by third-party clients (and sometimes their browsers),
  // so allow any origin — these are public, credential-free documents.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(body);
}

// RFC 8414 — Authorization Server Metadata.
router.get('/oauth-authorization-server', (req, res) => sendMeta(res, authServerMetadata()));

// RFC 9728 — Protected Resource Metadata. Served at both the bare path and the
// resource-path-suffixed variant (…/oauth-protected-resource/api/mcp) that a
// client derives from the resource URL; both point at the same document.
router.get('/oauth-protected-resource', (req, res) => sendMeta(res, protectedResourceMetadata()));
router.get('/oauth-protected-resource/api/mcp', (req, res) => sendMeta(res, protectedResourceMetadata()));

module.exports = router;
