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
    // AuditLog: a database can hold a plain {timestamp:1} index that conflicts
    // with the TTL index (same key pattern, different options) and silently
    // blocks its creation — the sync drops the stale one so TTL expiry works.
    const AuditLog = require('../models/AuditLog');
    AuditLog.syncIndexes().catch(err =>
      console.warn('[db] AuditLog.syncIndexes failed:', err.message)
    );
    const WineList = require('../models/WineList');
    WineList.syncIndexes().catch(err =>
      console.warn('[db] WineList.syncIndexes failed:', err.message)
    );
    // ImportSession: the TTL index has no partial filter (every session is a
    // draft). A database can hold an index on the same key with a
    // {status:'draft'} filter (different options); the sync replaces it.
    const ImportSession = require('../models/ImportSession');
    ImportSession.syncIndexes().catch(err =>
      console.warn('[db] ImportSession.syncIndexes failed:', err.message)
    );
    // RegistryDataValue: the one-published-per-slot unique index includes
    // `vintage`, so a wine+key can hold a default AND a per-vintage override.
    // A narrower { wineDefinition, key, status } partial unique index would
    // forbid that — the sync drops it and creates the four-key one.
    const RegistryDataValue = require('../models/RegistryDataValue');
    RegistryDataValue.syncIndexes().catch(err =>
      console.warn('[db] RegistryDataValue.syncIndexes failed:', err.message)
    );
    // WineEmbedding: the vectors live on the rows. The sync drops any unique
    // { qdrantPointId } index (a new row has no point id, so it would reject
    // the second one) and creates the { model, indexVersion, dim, embeddedAt }
    // index the search reads.
    const WineEmbedding = require('../models/WineEmbedding');
    WineEmbedding.syncIndexes().catch(err =>
      console.warn('[db] WineEmbedding.syncIndexes failed:', err.message)
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
