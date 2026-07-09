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
    const Review = require('../models/Review');
    Review.syncIndexes().catch(err =>
      console.warn('[db] Review.syncIndexes failed:', err.message)
    );
    // AuditLog: existing DBs hold a plain {timestamp:1} index that conflicts
    // with the TTL index (same key pattern, different options) and silently
    // blocked its creation — the sync drops the stale one so TTL expiry works.
    const AuditLog = require('../models/AuditLog');
    AuditLog.syncIndexes().catch(err =>
      console.warn('[db] AuditLog.syncIndexes failed:', err.message)
    );
    const WineList = require('../models/WineList');
    WineList.syncIndexes().catch(err =>
      console.warn('[db] WineList.syncIndexes failed:', err.message)
    );
    // ImportSession: the TTL index dropped its dead {status:'draft'} partial
    // filter (every session is a draft) — sync replaces the old conflicting
    // index (same key, different options) on existing databases.
    const ImportSession = require('../models/ImportSession');
    ImportSession.syncIndexes().catch(err =>
      console.warn('[db] ImportSession.syncIndexes failed:', err.message)
    );
  } catch (error) {
    // Log the reason (DNS, auth, TLS, bad URI) but mask any credentials
    // embedded in a mongodb:// URI that error messages may echo back.
    const msg = String(error.message || error).replace(/\/\/[^@/]*@/, '//<credentials>@');
    console.error('MongoDB Connection Error:', msg);
    process.exit(1);
  }
};

module.exports = connectDB;
