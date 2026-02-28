/**
 * Demo seed script: creates minimal sample data so contributors can
 * run the app straight after cloning.
 *
 * Run via:
 *   docker exec cellarion-backend node src/seed-demo.js
 *
 * Default credentials created:
 *   Admin:  admin@cellarion.app / Admin1234!demo
 *   User:   user@cellarion.app  / User1234!demo
 *
 * Data created:
 *   2 countries  (France, New Zealand)
 *   2 regions    (Bordeaux, Marlborough)
 *   1 district   (Margaux AOC)
 *   5 grapes     (Cabernet Sauvignon, Merlot, Cabernet Franc, Petit Verdot, Sauvignon Blanc)
 *   2 wines      (Château Margaux, Cloudy Bay Sauvignon Blanc)
 *   1 demo cellar with 5 demo bottles
 */

'use strict';

const mongoose = require('mongoose');
const { generateWineKey } = require('./utils/normalize');

const User = require('./models/User');
const Country = require('./models/Country');
const Region = require('./models/Region');
const Grape = require('./models/Grape');
const WineDefinition = require('./models/WineDefinition');
const Cellar = require('./models/Cellar');
const Bottle = require('./models/Bottle');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // ─── Users ───────────────────────────────────────────────────────────────────
  let admin = await User.findOne({ email: 'admin@cellarion.app' });
  if (!admin) {
    admin = await User.create({
      username: 'admin',
      email: 'admin@cellarion.app',
      password: 'Admin1234!demo',
      roles: ['admin'],
      emailVerified: true
    });
    console.log('  Created: admin@cellarion.app (admin)');
  } else {
    console.log('  Exists:  admin@cellarion.app');
  }

  let demoUser = await User.findOne({ email: 'user@cellarion.app' });
  if (!demoUser) {
    demoUser = await User.create({
      username: 'demouser',
      email: 'user@cellarion.app',
      password: 'User1234!demo',
      roles: ['user'],
      emailVerified: true
    });
    console.log('  Created: user@cellarion.app (user)');
  } else {
    console.log('  Exists:  user@cellarion.app');
  }

  // ─── Countries ───────────────────────────────────────────────────────────────
  const countryData = [
    { name: 'France',      code: 'FR' },
    { name: 'New Zealand', code: 'NZ' },
  ];

  const countries = {};
  for (const c of countryData) {
    const normalized = c.name.toLowerCase();
    let doc = await Country.findOne({ normalizedName: normalized });
    if (!doc) {
      doc = await Country.create({ ...c, normalizedName: normalized, createdBy: admin._id });
      console.log(`  Country: ${c.name}`);
    }
    countries[c.code] = doc;
  }

  // ─── Regions ─────────────────────────────────────────────────────────────────
  const regionData = [
    { name: 'Bordeaux',    code: 'FR' },
    { name: 'Marlborough', code: 'NZ' },
  ];

  const regions = {};
  for (const r of regionData) {
    const normalized = r.name.toLowerCase().replace(/\s+/g, ' ').trim();
    const countryDoc = countries[r.code];
    let doc = await Region.findOne({ country: countryDoc._id, normalizedName: normalized });
    if (!doc) {
      doc = await Region.create({
        name: r.name,
        normalizedName: normalized,
        country: countryDoc._id,
        createdBy: admin._id
      });
      console.log(`  Region: ${r.name}`);
    }
    regions[r.name] = doc;
  }

  // ─── Grapes ──────────────────────────────────────────────────────────────────
  const grapeData = [
    { name: 'Cabernet Sauvignon', synonyms: ['Cab Sauv', 'CS'] },
    { name: 'Merlot',             synonyms: [] },
    { name: 'Cabernet Franc',     synonyms: ['Cab Franc', 'CF'] },
    { name: 'Petit Verdot',       synonyms: [] },
    { name: 'Sauvignon Blanc',    synonyms: ['Sauv Blanc', 'SB'] },
  ];

  const grapes = {};
  for (const g of grapeData) {
    const normalized = g.name.toLowerCase().replace(/\s+/g, ' ').trim();
    let doc = await Grape.findOne({ normalizedName: normalized });
    if (!doc) {
      doc = await Grape.create({
        name: g.name,
        normalizedName: normalized,
        synonyms: g.synonyms,
        createdBy: admin._id
      });
      console.log(`  Grape: ${g.name}`);
    }
    grapes[g.name] = doc;
  }

  // ─── Wine definitions ────────────────────────────────────────────────────────
  const wineSpecs = [
    {
      name: 'Château Margaux',
      producer: 'Château Margaux',
      countryCode: 'FR',
      region: 'Bordeaux',
      appellation: 'Margaux AOC',
      grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
      type: 'red',
      description: 'First Growth from the Médoc, celebrated for its silky texture and floral aromatics.'
    },
    {
      name: 'Cloudy Bay Sauvignon Blanc',
      producer: 'Cloudy Bay',
      countryCode: 'NZ',
      region: 'Marlborough',
      appellation: null,
      grapes: ['Sauvignon Blanc'],
      type: 'white',
      description: 'New Zealand benchmark Sauvignon Blanc with vibrant citrus and passionfruit notes.'
    },
  ];

  const wineMap = {};
  for (const spec of wineSpecs) {
    const normalizedKey = generateWineKey(spec.name, spec.producer, spec.appellation || '');
    let doc = await WineDefinition.findOne({ normalizedKey });
    if (!doc) {
      const grapeIds = (spec.grapes || [])
        .filter(g => grapes[g])
        .map(g => grapes[g]._id);
      doc = await WineDefinition.create({
        name: spec.name,
        producer: spec.producer,
        country: countries[spec.countryCode]._id,
        region: spec.region ? (regions[spec.region]?._id || null) : null,
        appellation: spec.appellation || undefined,
        grapes: grapeIds,
        type: spec.type,
        description: spec.description,
        normalizedKey,
        createdBy: admin._id
      });
      console.log(`  Wine: ${spec.name}`);
    } else {
      console.log(`  Wine (exists): ${spec.name}`);
    }
    wineMap[spec.name] = doc;
  }

  // ─── Demo cellar + bottles ────────────────────────────────────────────────────
  let cellar = await Cellar.findOne({ user: demoUser._id, name: 'Demo Cellar' });
  if (!cellar) {
    cellar = await Cellar.create({
      name: 'Demo Cellar',
      description: 'Sample bottles to explore Cellarion features',
      user: demoUser._id
    });
    console.log('  Cellar: Demo Cellar');
  }

  const bottleSpecs = [
    {
      wine: 'Château Margaux',
      vintage: '2018',
      count: 3,
      price: 850,
      currency: 'USD',
      rating: 5,
      notes: 'Deep ruby with cassis, cedar, and floral notes. A classic Margaux.'
    },
    {
      wine: 'Cloudy Bay Sauvignon Blanc',
      vintage: '2023',
      count: 6,
      price: 25,
      currency: 'USD',
      rating: 4,
      notes: 'Fresh and vibrant. Ready to drink now.'
    },
  ];

  for (const spec of bottleSpecs) {
    const wine = wineMap[spec.wine];
    if (!wine) { console.warn(`  Skipping — wine not found: ${spec.wine}`); continue; }
    const exists = await Bottle.findOne({ cellar: cellar._id, wineDefinition: wine._id, vintage: spec.vintage });
    if (!exists) {
      for (let i = 0; i < spec.count; i++) {
        await Bottle.create({
          cellar: cellar._id,
          wineDefinition: wine._id,
          user: demoUser._id,
          vintage: spec.vintage,
          price: spec.price,
          currency: spec.currency,
          rating: spec.rating,
          notes: spec.notes
        });
      }
      console.log(`  Bottles: ${spec.wine} ${spec.vintage} ×${spec.count}`);
    }
  }

  console.log('\nDemo seed complete!');
  console.log('  Admin: admin@cellarion.app / Admin1234!demo');
  console.log('  User:  user@cellarion.app  / User1234!demo');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
