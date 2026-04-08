/**
 * One-time migration: rename plan values for the supporter tier system.
 *
 *   basic   -> supporter
 *   premium -> patron
 *   free    -> free (no change)
 *
 * Run with: docker exec cellarion-backend node src/migrate-plans-to-supporter.js
 * Or locally: node src/migrate-plans-to-supporter.js
 *
 * Safe to run multiple times — it only updates docs that still have old values.
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';

async function migrate() {
  console.log('Connecting to', MONGO_URI.replace(/\/\/[^@]+@/, '//***@'));
  await mongoose.connect(MONGO_URI);

  const db = mongoose.connection.db;
  const users = db.collection('users');

  // Rename basic -> supporter
  const basicResult = await users.updateMany(
    { plan: 'basic' },
    { $set: { plan: 'supporter' } }
  );
  console.log(`basic -> supporter: ${basicResult.modifiedCount} user(s) updated`);

  // Rename premium -> patron
  const premiumResult = await users.updateMany(
    { plan: 'premium' },
    { $set: { plan: 'patron' } }
  );
  console.log(`premium -> patron: ${premiumResult.modifiedCount} user(s) updated`);

  // Also update any aiConfig document that has old plan keys in chatDailyLimits
  const siteConfigs = db.collection('siteconfigs');
  const aiDoc = await siteConfigs.findOne({ key: 'aiConfig' });
  if (aiDoc?.value?.chatDailyLimits) {
    const limits = aiDoc.value.chatDailyLimits;
    if (limits.basic !== undefined || limits.premium !== undefined) {
      const newLimits = {
        free: limits.free ?? 5,
        supporter: limits.basic ?? limits.supporter ?? 50,
        patron: limits.premium ?? limits.patron ?? -1,
      };
      await siteConfigs.updateOne(
        { key: 'aiConfig' },
        { $set: { 'value.chatDailyLimits': newLimits } }
      );
      console.log('aiConfig chatDailyLimits migrated:', JSON.stringify(newLimits));
    } else {
      console.log('aiConfig chatDailyLimits already using new keys');
    }
  }

  console.log('Migration complete.');
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
