/**
 * Migration: backfill Appellation taxonomy from existing WineDefinitions
 *
 * Scans every WineDefinition that has a non-empty appellation string and
 * creates a matching Appellation document (country + region + name) if one
 * does not already exist.
 *
 * Run via:
 *   docker exec cellarion-backend node src/migrate-appellations.js
 *
 * Safe to run multiple times — uses findOneAndUpdate with upsert:false logic
 * so it only inserts documents that are genuinely missing.
 */

'use strict';

const mongoose = require('mongoose');
const { normalizeString } = require('./utils/normalize');

const User = require('./models/User');
const WineDefinition = require('./models/WineDefinition');
const Appellation = require('./models/Appellation');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

async function migrate() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Use any admin user as the createdBy reference
  const adminUser = await User.findOne({ roles: 'admin' }).select('_id');
  if (!adminUser) {
    console.error('No admin user found. Seed the database first.');
    process.exit(1);
  }

  // Fetch all wines that have a non-empty appellation string
  const wines = await WineDefinition.find({
    appellation: { $exists: true, $ne: '', $ne: null }
  }).select('name appellation country region');

  if (wines.length === 0) {
    console.log('No wines with appellations found. Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${wines.length} wine(s) with an appellation field.`);

  let created = 0;
  let skipped = 0;

  for (const wine of wines) {
    const name = wine.appellation.trim();
    if (!name) { skipped++; continue; }

    const countryId = wine.country;
    if (!countryId) {
      console.log(`  SKIP  "${name}" — wine "${wine.name}" has no country set`);
      skipped++;
      continue;
    }

    const normalizedName = normalizeString(name);
    const regionId = wine.region || null;

    // Check if this (country + normalizedName) already exists
    const existing = await Appellation.findOne({ country: countryId, normalizedName });
    if (existing) {
      console.log(`  exists  "${name}" (country: ${countryId})`);
      skipped++;
      continue;
    }

    await Appellation.create({
      name,
      normalizedName,
      country: countryId,
      region: regionId,
      createdBy: adminUser._id
    });

    console.log(`  created "${name}" (country: ${countryId}${regionId ? `, region: ${regionId}` : ''})`);
    created++;
  }

  console.log(`\nDone. Created: ${created}  Already existed: ${skipped}`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
