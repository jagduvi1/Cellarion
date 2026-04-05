const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { getClientIp } = require('./utils/clientIp');
const { requireAuth } = require('./middleware/auth');
const healthRoute = require('./routes/health');
const authRoute = require('./routes/auth');
const usersRoute = require('./routes/users');
const winesRoute = require('./routes/wines');
const cellarsRoute = require('./routes/cellars');
const bottlesRoute = require('./routes/bottles');
const wineRequestsRoute = require('./routes/wineRequests');
const adminTaxonomyRoute = require('./routes/admin/taxonomy');
const adminWinesRoute = require('./routes/admin/wines');
const adminWineRequestsRoute = require('./routes/admin/wineRequests');
const adminImagesRoute = require('./routes/admin/images');
const adminAuditRoute = require('./routes/admin/audit');
const adminUsersRoute = require('./routes/admin/users');
const adminSettingsRoute = require('./routes/admin/settings');
const adminImportRoute = require('./routes/admin/import');
const adminCellarsRoute = require('./routes/admin/cellars');
const adminSupportTicketsRoute = require('./routes/admin/supportTickets');
const adminWineReportsRoute = require('./routes/admin/wineReports');
const supportRoute = require('./routes/support');
const wineReportsRoute = require('./routes/wineReports');
const importRoute = require('./routes/import');
const racksRoute = require('./routes/racks');
const cellarLayoutRoute = require('./routes/cellarLayout');
const imagesRoute = require('./routes/images');
const sommMaturityRoute = require('./routes/somm/maturity');
const sommPricesRoute  = require('./routes/somm/prices');
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
const rateLimitsConfig = require('./config/rateLimits');
const aiConfig = require('./config/aiConfig');
const { logAudit } = require('./services/audit');

const app = express();

// Trust two proxy hops: Traefik → frontend nginx → backend.
// req.ip is used as fallback when CF-Connecting-IP is absent (local dev).
app.set('trust proxy', 2);

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
app.use(cookieParser());
// Routes that accept base64 images need a larger body limit
app.use('/api/images/remove-bg-preview', express.json({ limit: '5mb' }));
app.use('/api/wine-requests', express.json({ limit: '5mb' }));
app.use('/api/admin/wine-requests', express.json({ limit: '5mb' }));
app.use('/api/wines/scan-label', express.json({ limit: '300kb' }));
app.use('/api/wines/find-or-create', express.json({ limit: '5mb' }));
app.use('/api/bottles/import/sessions', express.json({ limit: '5mb' }));
app.use('/api/bottles/import', express.json({ limit: '2mb' }));
app.use('/api/blog/admin/posts', express.json({ limit: '2mb' }));
app.use('/api/wine-lists', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '10kb' }));
const corsOrigin = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:3000');
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.warn('[security] FRONTEND_URL is not set — CORS will block all cross-origin requests in production');
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

// IndexNow key verification file
const indexNowKey = process.env.INDEXNOW_KEY;
if (indexNowKey) {
  app.get(`/api/${indexNowKey}.txt`, (req, res) => {
    res.type('text/plain').send(indexNowKey);
  });
}

// Global API rate limiter — default 200 requests per 15 min per IP (admin-configurable)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().api.max,
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
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
  keyGenerator: (req) => getClientIp(req),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'write', limit: rateLimitsConfig.get().write.max });
    res.status(429).json({ error: 'Too many write requests, please try again later' });
  }
});
app.use('/api/', writeLimiter);

// Serve uploaded images — no auth required (filenames are random UUIDs).
// Long cache: images are immutable once uploaded.
app.use('/api/uploads', (req, res, next) => {
  const ext = path.extname(req.path).toLowerCase();
  const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];
  if (!allowedExts.includes(ext)) {
    return res.status(403).json({ error: 'File type not allowed' });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}, express.static('/app/uploads'));

// Routes
app.use('/api/health', healthRoute);
app.use('/api/auth', authRoute);
app.use('/api/users', usersRoute);
app.use('/api/wines', winesRoute);
app.use('/api/cellars', cellarsRoute);
app.use('/api/bottles', bottlesRoute);
app.use('/api/wine-requests', wineRequestsRoute);
app.use('/api/admin/taxonomy', adminTaxonomyRoute);
app.use('/api/admin/wines', adminWinesRoute);
app.use('/api/admin/wine-requests', adminWineRequestsRoute);
app.use('/api/admin/images', adminImagesRoute);
app.use('/api/admin/audit', adminAuditRoute);
app.use('/api/admin/users', adminUsersRoute);
app.use('/api/admin/settings', adminSettingsRoute);
app.use('/api/admin/import', adminImportRoute);
app.use('/api/admin/cellars', adminCellarsRoute);
app.use('/api/admin/support-tickets', adminSupportTicketsRoute);
app.use('/api/admin/wine-reports', adminWineReportsRoute);
app.use('/api/support', supportRoute);
app.use('/api/wine-reports', wineReportsRoute);
app.use('/api/bottles/import', importRoute);
app.use('/api/racks', racksRoute);
app.use('/api/cellar-layout', cellarLayoutRoute);
app.use('/api/images', imagesRoute);
app.use('/api/somm/maturity', sommMaturityRoute);
app.use('/api/somm/prices',  sommPricesRoute);
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
app.use('/api/wishlist', wishlistRoute);
app.use('/api/recommendations', recommendationsRoute);
app.use('/api/journal', journalRoute);
app.use('/api/restock-alerts', restockAlertsRoute);
app.use('/api/help', helpRoute);
app.use('/api/wine-lists', wineListsRoute);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Centralized error handler — catches errors passed via next(err)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
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

module.exports = app;
