/**
 * One-time migration: convert single `role` string → `roles` array.
 *
 * Run with:
 *   node src/scripts/migrate-roles.js
 *
 * Safe to run multiple times — skips documents that already have a `roles` array.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/wine_cellar');
  console.log('Connected to MongoDB');

  const db = mongoose.connection.db;
  const users = db.collection('users');

  // Find documents that still have the old single `role` field and no `roles` array
  const cursor = users.find({ role: { $exists: true }, roles: { $exists: false } });
  let migrated = 0;

  for await (const doc of cursor) {
    const oldRole = doc.role || 'user';
    await users.updateOne(
      { _id: doc._id },
      {
        $set: { roles: [oldRole] },
        $unset: { role: '' }
      }
    );
    migrated++;
    console.log(`  Migrated user "${doc.username}": role="${oldRole}" → roles=["${oldRole}"]`);
  }

  console.log(`\nDone. Migrated ${migrated} user(s).`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
