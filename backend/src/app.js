const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { rateLimitKey } = require('./utils/clientIp');
const { requireAuth } = require('./middleware/auth');
const { uploadsGuard } = require('./middleware/uploadsStatic');
const healthRoute = require('./routes/health');
const siteRoute = require('./routes/site');
const authRoute = require('./routes/auth');
const oauthRoute = require('./routes/oauth');
const usersRoute = require('./routes/users');
const winesRoute = require('./routes/wines');
const cellarsRoute = require('./routes/cellars');
const bottlesRoute = require('./routes/bottles');
const wineRequestsRoute = require('./routes/wineRequests');
const adminTaxonomyRoute = require('./routes/admin/taxonomy');
const adminSearchRoute = require('./routes/admin/search');
const adminWinesRoute = require('./routes/admin/wines');
const adminWineRequestsRoute = require('./routes/admin/wineRequests');
const adminImagesRoute = require('./routes/admin/images');
const adminAuditRoute = require('./routes/admin/audit');
const adminSecurityRoute = require('./routes/admin/security');
const adminUsersRoute = require('./routes/admin/users');
const adminSettingsRoute = require('./routes/admin/settings');
const adminImportRoute = require('./routes/admin/import');
const adminCellarsRoute = require('./routes/admin/cellars');
const adminSupportTicketsRoute = require('./routes/admin/supportTickets');
const adminWineReportsRoute = require('./routes/admin/wineReports');
const adminWineProposalsRoute = require('./routes/admin/wineProposals');
const adminStatsRoute = require('./routes/admin/stats');
const adminMcpRoute = require('./routes/admin/mcp');
const aiBudgetRoute = require('./routes/aiBudget');
const adminAiBudgetRequestsRoute = require('./routes/admin/aiBudgetRequests');
const supportRoute = require('./routes/support');
const wineReportsRoute = require('./routes/wineReports');
const importRoute = require('./routes/import');
const cellarImportRoute = require('./routes/cellarImport');
const racksRoute = require('./routes/racks');
const cellarLayoutRoute = require('./routes/cellarLayout');
const imagesRoute = require('./routes/images');
const sommMaturityRoute = require('./routes/somm/maturity');
const sommPricesRoute  = require('./routes/somm/prices');
const sommWineProfileRoute = require('./routes/somm/wineProfile');
const notificationsRoute = require('./routes/notifications');
const statsRoute = require('./routes/stats');
const superAdminRoute = require('./routes/superadmin');
const chatRoute = require('./routes/chat');
const adminAiRoute = require('./routes/admin/ai');
const settingsRoute = require('./routes/settings');
const reviewsRoute = require('./routes/reviews');
const followsRoute = require('./routes/follows');
const discussionsRoute = require('./routes/discussions');
const pushSubscriptionsRoute = require('./routes/pushSubscriptions');
const blogRoute = require('./routes/blog');
const wishlistRoute = require('./routes/wishlist');
const recommendationsRoute = require('./routes/recommendations');
const journalRoute = require('./routes/journal');
const restockAlertsRoute = require('./routes/restockAlerts');
const helpRoute = require('./routes/help');
const wineListsRoute = require('./routes/wineLists');
const wineListPublicRoute = require('./routes/wineListPublic');
const sitemapRoute = require('./routes/sitemap');
const ogRoute = require('./routes/og');
const taxonomyRoute = require('./routes/taxonomy');
const stripeRoute = require('./routes/stripe');
const tokensRoute = require('./routes/tokens');
const eventsRoute = require('./routes/events');
const climateRoute = require('./routes/climate');
const mcpRoute = require('./routes/mcp');
const mcpOAuthRoute = require('./routes/mcpOAuth');
const wellKnownOAuthRoute = require('./routes/wellKnownOAuth');
const rateLimitsConfig = require('./config/rateLimits');
const aiConfig = require('./config/aiConfig');
const announcementConfig = require('./config/announcement');
const { logAudit, logger } = require('./services/audit');

const app = express();

// How many reverse-proxy hops sit in front of Express, i.e. how many trailing
// X-Forwarded-For entries Express may trust when resolving req.ip (the per-IP
// rate-limit + audit key when CF-Connecting-IP is absent). Security audit M-3:
// this MUST match the actual chain — trusting MORE hops than exist lets a client
// forge req.ip via a spoofed XFF prefix and get a fresh bucket on every limiter.
//   - Shipped compose (nginx → backend): 1 hop. This is the default.
//   - Hosted prod (Cloudflare → Traefik → nginx → backend): set TRUST_PROXY_HOPS=2
//     so req.ip resolves to the Cloudflare edge IP and getClientIp() can trust
//     CF-Connecting-IP. Without it, req.ip collapses to Traefik's internal IP and
//     every per-IP limiter shares one bucket. See utils/clientIp.js.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
app.set('trust proxy', Number.isFinite(trustProxyHops) ? trustProxyHops : 1);

// Security headers — explicit config for production SaaS
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
    },
  }
}));

// Middleware
app.use(compression());
app.use(cookieParser()); // lgtm[js/missing-token-validation] — auth uses JWT Bearer tokens, not cookies; CSRF does not apply
// Stripe webhook needs the raw body for signature verification — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// Routes that accept base64 images need a larger body limit
app.use('/api/images/remove-bg-preview', express.json({ limit: '5mb' }));
app.use('/api/wine-requests', express.json({ limit: '5mb' }));
app.use('/api/admin/wine-requests', express.json({ limit: '5mb' }));
app.use('/api/wines/scan-label', express.json({ limit: '300kb' }));
app.use('/api/wines/find-or-create', express.json({ limit: '5mb' }));
app.use('/api/bottles/import/sessions', express.json({ limit: '5mb' }));
// /confirm posts the whole selected batch in one request (rack placement is
// coordinated batch-wide), so the limit must hold a large import — up to
// MAX_IMPORT_SIZE (2000) items with notes. 8mb leaves comfortable headroom.
app.use('/api/bottles/import', express.json({ limit: '8mb' }));
app.use('/api/blog/admin/posts', express.json({ limit: '2mb' }));
app.use('/api/wine-lists', express.json({ limit: '1mb' }));
// MCP: the anonymous public surface stays tiny (no image tool) — registered
// BEFORE the personal /api/mcp rule so /api/mcp/public matches it first (the
// first express.json to parse wins). The personal endpoint allows a larger
// body for attach_bottle_image's base64 mode (MAX_BASE64_CHARS ≈ 1.5MB + JSON
// overhead); every personal MCP caller is authenticated and rate-limited.
app.use('/api/mcp/public', express.json({ limit: '10kb' }));
app.use('/api/mcp', express.json({ limit: '2mb' }));
app.use(express.json({ limit: '10kb' }));
const corsOrigin = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3000');
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.warn('[security] FRONTEND_URL is not set — CORS will block all cross-origin requests, AND every email unsubscribe / verification / password-reset link will point at http://localhost:3000');
}
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Public wine list PDF — before rate limiter (has its own limiter)
app.use('/api/wine-lists/public', wineListPublicRoute);

// Sitemap, OG & IndexNow — before rate limiter so crawlers are never blocked
app.use('/sitemap.xml', sitemapRoute);
app.use('/api/sitemap.xml', sitemapRoute);
app.use('/api/og', ogRoute);

// OAuth discovery documents (RFC 8414 + RFC 9728) for the MCP connector flow.
// MUST be at the issuer origin root and never rate-limited/blocked, so they are
// mounted here alongside sitemap/OG. ⚠️ PROD nginx must proxy /.well-known/oauth-*
// to the backend — see docs/mcp-oauth.md.
app.use('/.well-known', wellKnownOAuthRoute);

// IndexNow key verification file
const indexNowKey = process.env.INDEXNOW_KEY;
if (indexNowKey) {
  app.get(`/api/${indexNowKey}.txt`, (req, res) => {
    res.type('text/plain').send(indexNowKey);
  });
}

// The Stripe webhook authenticates via signature + idempotency and is delivered
// from Stripe's small IP pool, so per-IP limiting only risks 429-ing legitimate
// billing bursts (or a dashboard "resend all"). Exempt it — same spirit as the
// sitemap/OG/public-wine-list routes that are mounted before the limiters.
const isStripeWebhook = (req) => req.originalUrl.split('?')[0] === '/api/stripe/webhook';

// The MCP endpoint is a single JSON-RPC envelope (POST-only, stateless Streamable
// HTTP). One POST may be a harmless `initialize`/`tools/list` or a `tools/call`
// that writes — the HTTP write limiter can't tell them apart, so limiting it at
// this layer would throttle the read-mostly handshake while providing no real
// write protection. Per-tool authorization (registry scope filter) and, for
// write tools, the write-safety layers govern MCP mutations instead.
//
// The MCP endpoints are ALSO exempt from the global per-IP apiLimiter
// (MCP-audit M8): hosted AI connectors (claude.ai, ChatGPT) egress from a
// small shared IP pool, so a per-IP bucket here made every hosted user share
// one 15-minute allowance — one chatty agent starved the rest. The personal
// endpoint carries its own TWO dedicated limiters in routes/mcp.js (a high
// per-IP pre-auth flood guard + a per-USER fair-share ceiling after auth);
// /api/mcp/public keeps its own strict per-IP limiter there (60/15min, far
// below the global cap — anonymous callers have no user to key on).
//
// A JSON-RPC body may be a *batch* (array) of calls, so one HTTP request can
// fan out to many tool invocations — HTTP limiters count requests, not calls.
// That amplification is capped in mcp/server.js at TWO layers: the per-request
// tool-call budget (MAX_CALLS_PER_REQUEST) and, for MUTATING tools, a per-user
// budget sharing the SAME admin-tunable number as this writeLimiter — so an
// agent looping consumes hits exactly the wall a looping REST client would.
// Revisit again before AI-spending tools ship (enrichment adds cost beyond DB).
//
// The OAuth endpoints under /api/mcp/oauth/ are exempt for the SAME shared-egress
// reason. They were left behind when M8 exempted the protocol endpoint, so
// /token, /authorize, /register and /revoke still rode both the per-IP apiLimiter
// and the writeLimiter. Access tokens live one hour, so every connected client
// refreshes at least hourly — and a hosted platform's entire user base does that
// from one egress IP, which is exactly the bucket-sharing M8 removed next door.
// A user whose refresh is 429'd is silently disconnected mid-conversation, and
// the 429 body isn't OAuth-shaped either, so clients report it as a broken server.
// Registration keeps its own dedicated per-IP limiter in routes/mcpOAuth.js —
// the anti-flood guard that actually needs to be per-IP.
const isMcp = (req) => {
  const p = req.originalUrl.split('?')[0];
  return p === '/api/mcp' || p === '/api/mcp/' || p === '/api/mcp/public'
    || p.startsWith('/api/mcp/oauth/');
};

// Global API rate limiter — default 200 requests per 15 min per IP (admin-configurable)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().api.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isStripeWebhook(req) || isMcp(req),
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'api', limit: rateLimitsConfig.get().api.max });
    res.status(429).json({ error: 'Too many requests, please try again later' });
  }
});
app.use('/api/', apiLimiter);

// Stricter limiter for write operations (POST/PUT/DELETE/PATCH) — default 60 per 15 min
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().write.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isStripeWebhook(req) || isMcp(req) || req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'write', limit: rateLimitsConfig.get().write.max });
    res.status(429).json({ error: 'Too many write requests, please try again later' });
  }
});
app.use('/api/', writeLimiter);

// Serve uploaded images — no auth required (filenames are random UUIDs).
// Long cache: images are immutable once uploaded.
app.use('/api/uploads', uploadsGuard, express.static('/app/uploads'));

// Routes
app.use('/api/health', healthRoute);
app.use('/api/site', siteRoute);
app.use('/api/auth', authRoute);
// SSO / OAuth endpoints (Google) live under the same /api/auth prefix. Mounted
// after authRoute; their subpaths (/google, /sso/providers) don't collide with
// the password-auth routes.
app.use('/api/auth', oauthRoute);
app.use('/api/users', usersRoute);
app.use('/api/wines', winesRoute);
app.use('/api/cellars', cellarsRoute);
app.use('/api/bottles', bottlesRoute);
app.use('/api/wine-requests', wineRequestsRoute);
app.use('/api/admin/taxonomy', adminTaxonomyRoute);
app.use('/api/admin/search', adminSearchRoute);
app.use('/api/admin/wines', adminWinesRoute);
app.use('/api/admin/wine-requests', adminWineRequestsRoute);
app.use('/api/admin/images', adminImagesRoute);
app.use('/api/admin/audit', adminAuditRoute);
app.use('/api/admin/security', adminSecurityRoute);
app.use('/api/admin/users', adminUsersRoute);
app.use('/api/admin/settings', adminSettingsRoute);
app.use('/api/admin/import', adminImportRoute);
app.use('/api/admin/cellars', adminCellarsRoute);
app.use('/api/admin/support-tickets', adminSupportTicketsRoute);
app.use('/api/admin/wine-reports', adminWineReportsRoute);
app.use('/api/admin/wine-proposals', adminWineProposalsRoute);
app.use('/api/admin/stats', adminStatsRoute);
app.use('/api/admin/mcp', adminMcpRoute);
app.use('/api/ai-budget', aiBudgetRoute);
app.use('/api/admin/ai-budget-requests', adminAiBudgetRequestsRoute);
app.use('/api/support', supportRoute);
app.use('/api/wine-reports', wineReportsRoute);
app.use('/api/bottles/import', importRoute);
app.use('/api/cellar-import', cellarImportRoute);
app.use('/api/racks', racksRoute);
app.use('/api/cellar-layout', cellarLayoutRoute);
app.use('/api/images', imagesRoute);
app.use('/api/somm/maturity', sommMaturityRoute);
app.use('/api/somm/prices',  sommPricesRoute);
app.use('/api/somm/wine-profile', sommWineProfileRoute);
app.use('/api/notifications', notificationsRoute);
app.use('/api/stats', statsRoute);
app.use('/api/superadmin', superAdminRoute);
app.use('/api/chat', chatRoute);
app.use('/api/admin/ai', adminAiRoute);
app.use('/api/settings', settingsRoute);
app.use('/api/reviews', reviewsRoute);
app.use('/api/follows', followsRoute);
app.use('/api/discussions', discussionsRoute);
app.use('/api/push-subscriptions', pushSubscriptionsRoute);
app.use('/api/blog', blogRoute);
app.use('/api/taxonomy', taxonomyRoute);
app.use('/api/wishlist', wishlistRoute);
app.use('/api/recommendations', recommendationsRoute);
app.use('/api/journal', journalRoute);
app.use('/api/restock-alerts', restockAlertsRoute);
app.use('/api/help', helpRoute);
app.use('/api/wine-lists', wineListsRoute);
app.use('/api/stripe', stripeRoute);
app.use('/api/tokens', tokensRoute);
app.use('/api/events', eventsRoute);
app.use('/api/climate', climateRoute);
// OAuth 2.1 authorization server for the MCP connector (DCR + PKCE + token
// exchange). Mounted BEFORE /api/mcp so /api/mcp/oauth/* resolves here and does
// not fall through to the (exact-path) MCP endpoint router.
app.use('/api/mcp/oauth', mcpOAuthRoute);
// Model Context Protocol endpoint — lets an external AI (Claude Desktop, etc.)
// read the connected user's own cellar over a scoped `cel_` token or a JWT.
// Stateless Streamable HTTP; per-tool authorization lives in the MCP registry.
app.use('/api/mcp', mcpRoute);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Centralized error handler — catches errors passed via next(err)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log through pino with field discipline (security audit L-4): a raw
  // console.error(err) dumped the full error + stack — potentially carrying
  // request PII — onto the un-TTL'd stdout stream that audit.js is careful to
  // keep PII out of. Log only the method/path/status + pino's err serializer
  // (type/message/stack), never req.body/headers.
  logger.error({ err, method: req.method, path: req.path, status: err.status || err.statusCode || 500 }, 'Unhandled request error');
  // If the response has already started (e.g. an SSE/stream route threw mid-
  // flight), we can't set a status/body — hand off to Express's default handler
  // which closes the connection.
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  // In production, never leak internal error messages to the client
  const message = process.env.NODE_ENV === 'production' && status >= 500
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(status).json({ error: message });
});

// Load rate limit configuration from DB on startup (non-blocking; falls back to defaults)
rateLimitsConfig.load().catch(err =>
  console.warn('[rateLimits] Startup load failed, using defaults:', err.message)
);

// Load AI feature-flag configuration from DB on startup
aiConfig.load().catch(err =>
  console.warn('[aiConfig] Startup load failed, using defaults:', err.message)
);

// Load the site announcement banner from DB on startup
announcementConfig.load().catch(err =>
  console.warn('[announcement] Startup load failed, using defaults:', err.message)
);

module.exports = app;
