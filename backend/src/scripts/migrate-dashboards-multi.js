/**
 * migrate-dashboards-multi.js — one-off for the multi-dashboard release.
 *
 * The first dashboard release (v1.137.0) shipped one-per-user with a UNIQUE
 * index on `user` alone. Multi-dashboard needs that index GONE (second
 * insert per user would E11000) and every existing row named.
 *
 * Idempotent: dropping a missing index is reported and skipped; the $set
 * only touches rows without a name.
 *
 * Run AFTER deploying the release that contains the new model:
 *   docker exec cellarion-backend node src/scripts/migrate-dashboards-multi.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  const col = mongoose.connection.collection('saveddashboards');

  const indexes = await col.indexes();
  const legacy = indexes.find((i) => i.unique && i.key && i.key.user === 1 && Object.keys(i.key).length === 1);
  if (legacy) {
    await col.dropIndex(legacy.name);
    console.log(`dropped legacy unique index ${legacy.name}`);
  } else {
    console.log('no legacy unique {user} index — nothing to drop');
  }

  const named = await col.updateMany(
    { $or: [{ name: null }, { name: { $exists: false } }, { name: '' }] },
    { $set: { name: 'My cellar' } }
  );
  console.log(`named ${named.modifiedCount} legacy dashboard(s)`);

  // Let Mongoose build the new compound unique index on next boot; creating
  // it here too makes the migration self-contained.
  await col.createIndex({ user: 1, name: 1 }, { unique: true });
  console.log('ensured unique {user, name} index');

  await mongoose.disconnect();
  console.log('Done.');
})().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
