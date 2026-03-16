const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected');

    // Sync indexes for models whose index definitions changed (drops stale, creates new).
    // Non-blocking — failures log a warning but don't prevent startup.
    const Rack = require('../models/Rack');
    Rack.syncIndexes().catch(err =>
      console.warn('[db] Rack.syncIndexes failed:', err.message)
    );
  } catch (error) {
    console.error('MongoDB Connection Error');
    process.exit(1);
  }
};

module.exports = connectDB;
