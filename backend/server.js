require('dotenv').config();

// Validate required environment variables before any setup
const requiredEnv = ['JWT_SECRET', 'MEILI_MASTER_KEY'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`FATAL: Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
  console.warn('Warning: MAILGUN_API_KEY / MAILGUN_DOMAIN not set — email verification disabled.');
}

const fs = require('fs');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const searchService = require('./src/services/search');

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

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
