require('dotenv').config();
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
  try {
    await searchService.initialize();
  } catch (err) {
    console.warn('Meilisearch initialization failed, continuing with MongoDB search:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
