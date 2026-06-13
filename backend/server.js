require('dotenv').config();

// Validate required environment variables before any setup
const requiredEnv = ['JWT_SECRET', 'MEILI_MASTER_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

// Reject weak / placeholder JWT secrets. Every access token is HS256-signed
// with this single symmetric key, and the project is open-source — so a
// deployment shipping a short or well-known default secret lets an attacker
// forge tokens for any user/role. Presence alone is not enough.
const JWT_PLACEHOLDERS = new Set([
  'change-me-to-a-strong-random-string',
  'dev-secret-change-me-in-production',
  'changeme', 'change-me', 'secret', 'your-secret-key', 'your_jwt_secret',
]);
if (process.env.JWT_SECRET.length < 32 || JWT_PLACEHOLDERS.has(process.env.JWT_SECRET.trim().toLowerCase())) {
  console.error('FATAL: JWT_SECRET is too weak. Use a random string of at least 32 characters, e.g. `openssl rand -hex 32`.');
  process.exit(1);
}

// Reject weak / placeholder MEILI_MASTER_KEY the same way. The key authenticates
// every request to Meilisearch; a deployment copying .env.example verbatim would
// otherwise boot with a publicly-known master key. Meili itself requires >=16
// chars in production mode — match that floor and block the shipped placeholders.
const MEILI_PLACEHOLDERS = new Set([
  'change-me-to-a-strong-random-string',
  'change-me-in-production',
  'masterkey', 'change-me', 'changeme',
]);
const meiliKey = process.env.MEILI_MASTER_KEY.trim();
if (meiliKey.length < 16 || MEILI_PLACEHOLDERS.has(meiliKey.toLowerCase())) {
  console.error('FATAL: MEILI_MASTER_KEY is too weak. Use a random string of at least 16 characters, e.g. `openssl rand -hex 16`.');
  process.exit(1);
}

if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
  console.warn('Warning: MAILGUN_API_KEY / MAILGUN_DOMAIN not set — email verification disabled.');
}

const fs = require('fs');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const searchService = require('./src/services/search');
const { startScheduler } = require('./src/services/scheduler');
const { cleanupOrphanedImages } = require('./src/services/imageProcessor');

const PORT = process.env.PORT || 5000;

// Ensure upload directories exist
['/app/uploads/originals', '/app/uploads/processed'].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// Connect to MongoDB, initialize search, then start server
connectDB().then(async () => {
  // Migration: drop old non-partial cellar name index so Mongoose can create the
  // updated partial one (user_1_name_1 with partialFilterExpression: {deletedAt: null})
  try {
    const mongoose = require('mongoose');
    await mongoose.connection.collection('cellars').dropIndex('user_1_name_1');
    console.log('[migration] Dropped old cellar name index — partial index will be created by Mongoose');
  } catch {
    // Index doesn't exist (first deploy) or already migrated — nothing to do
  }

  try {
    await searchService.initialize();
  } catch (err) {
    console.warn('Meilisearch initialization failed, continuing with MongoDB search:', err.message);
  }

  // Purge expired soft-deleted reply texts on startup and every 24h
  const DiscussionReply = require('./src/models/DiscussionReply');
  DiscussionReply.purgeExpiredDeletes().catch(() => {});
  setInterval(() => DiscussionReply.purgeExpiredDeletes().catch(() => {}), 24 * 60 * 60 * 1000);

  // Clean up orphaned images on startup and every hour
  cleanupOrphanedImages().catch(() => {});
  setInterval(() => cleanupOrphanedImages().catch(() => {}), 60 * 60 * 1000);

  // Start scheduled jobs (drink-window notifier, value snapshots)
  startScheduler();

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
  // Bound how long a single request may take to arrive so a slow/stalled client
  // (or a slowloris) can't tie up a socket indefinitely. These cap REQUEST
  // receipt, not response duration, so streaming responses (Cellar Chat SSE)
  // are unaffected — they send their request quickly and stream the reply.
  server.requestTimeout = 120000; // 2 min to receive the full request
  server.headersTimeout = 65000;  // 65s to receive request headers
});
