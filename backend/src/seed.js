/**
 * Seed script: populates the database with demo taxonomy, wines, users, and bottles.
 * Run via: docker exec wine-cellar-backend node src/seed.js
 *
 * Default credentials created:
 *   Admin:  admin@winecellar.com / Admin1234
 *   User:   user@winecellar.com  / User1234
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

  // ─── Users (first — all other docs use admin as createdBy) ──────────────────
  let admin = await User.findOne({ email: 'admin@winecellar.com' });
  if (!admin) {
    admin = await User.create({
      username: 'admin',
      email: 'admin@winecellar.com',
      password: 'Admin1234',
      role: 'admin'
    });
    console.log('  User: admin@winecellar.com (admin)');
  } else {
    console.log('  User (exists): admin@winecellar.com');
  }

  let demoUser = await User.findOne({ email: 'user@winecellar.com' });
  if (!demoUser) {
    demoUser = await User.create({
      username: 'wineuser',
      email: 'user@winecellar.com',
      password: 'User1234',
      role: 'user'
    });
    console.log('  User: user@winecellar.com (user)');
  } else {
    console.log('  User (exists): user@winecellar.com');
  }

  // ─── Countries ───────────────────────────────────────────────────────────────
  const countryData = [
    { name: 'France',        code: 'FR' },
    { name: 'Italy',         code: 'IT' },
    { name: 'Spain',         code: 'ES' },
    { name: 'United States', code: 'US' },
    { name: 'Australia',     code: 'AU' },
    { name: 'Argentina',     code: 'AR' },
    { name: 'Germany',       code: 'DE' },
    { name: 'Portugal',      code: 'PT' },
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
    { name: 'Bordeaux',         code: 'FR' },
    { name: 'Burgundy',         code: 'FR' },
    { name: 'Champagne',        code: 'FR' },
    { name: 'Rhône Valley',     code: 'FR' },
    { name: 'Alsace',           code: 'FR' },
    { name: 'Tuscany',          code: 'IT' },
    { name: 'Piedmont',         code: 'IT' },
    { name: 'Veneto',           code: 'IT' },
    { name: 'Rioja',            code: 'ES' },
    { name: 'Ribera del Duero', code: 'ES' },
    { name: 'Napa Valley',      code: 'US' },
    { name: 'Sonoma',           code: 'US' },
    { name: 'Barossa Valley',   code: 'AU' },
    { name: 'Mendoza',          code: 'AR' },
    { name: 'Mosel',            code: 'DE' },
    { name: 'Douro',            code: 'PT' },
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
    { name: 'Pinot Noir',         synonyms: ['PN'] },
    { name: 'Chardonnay',         synonyms: ['Chard'] },
    { name: 'Sauvignon Blanc',    synonyms: ['Sauv Blanc', 'SB'] },
    { name: 'Syrah',              synonyms: ['Shiraz'] },
    { name: 'Tempranillo',        synonyms: ['Tinto Fino', 'Tinto del País'] },
    { name: 'Nebbiolo',           synonyms: ['Chiavennasca'] },
    { name: 'Sangiovese',         synonyms: ['Brunello', 'Morellino'] },
    { name: 'Riesling',           synonyms: [] },
    { name: 'Grenache',           synonyms: ['Garnacha'] },
    { name: 'Malbec',             synonyms: ['Côt'] },
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
      name: 'Château Margaux', producer: 'Château Margaux',
      country: 'FR', region: 'Bordeaux', appellation: 'Margaux AOC',
      grapes: ['Cabernet Sauvignon', 'Merlot'], type: 'red',
      image: 'https://images.vivino.com/thumbs/Tz_mTVoaRGTRKNjWGjDHxA_pb_x600.png'
    },
    {
      name: 'Pétrus', producer: 'Pétrus',
      country: 'FR', region: 'Bordeaux', appellation: 'Pomerol AOC',
      grapes: ['Merlot'], type: 'red',
      image: 'https://images.vivino.com/thumbs/qA3BQwkqXFJEFMEn14-z4Q_pb_x600.png'
    },
    {
      name: 'Romanée-Conti', producer: 'Domaine de la Romanée-Conti',
      country: 'FR', region: 'Burgundy', appellation: 'Romanée-Conti AOC',
      grapes: ['Pinot Noir'], type: 'red', image: null
    },
    {
      name: 'Moët Brut Impérial', producer: 'Moët & Chandon',
      country: 'FR', region: 'Champagne', appellation: 'Champagne AOC',
      grapes: ['Chardonnay', 'Pinot Noir'], type: 'sparkling',
      image: 'https://images.vivino.com/thumbs/IMJiGhQ2VfWryjp9bZN_5g_pb_x600.png'
    },
    {
      name: 'Sassicaia', producer: 'Tenuta San Guido',
      country: 'IT', region: 'Tuscany', appellation: 'Bolgheri Sassicaia DOC',
      grapes: ['Cabernet Sauvignon'], type: 'red', image: null
    },
    {
      name: 'Barolo Sperss', producer: 'Gaja',
      country: 'IT', region: 'Piedmont', appellation: 'Barolo DOCG',
      grapes: ['Nebbiolo'], type: 'red', image: null
    },
    {
      name: 'Pingus', producer: 'Dominio de Pingus',
      country: 'ES', region: 'Ribera del Duero', appellation: 'Ribera del Duero DO',
      grapes: ['Tempranillo'], type: 'red', image: null
    },
    {
      name: 'Opus One', producer: 'Opus One Winery',
      country: 'US', region: 'Napa Valley', appellation: 'Napa Valley AVA',
      grapes: ['Cabernet Sauvignon', 'Merlot'], type: 'red',
      image: 'https://images.vivino.com/thumbs/2YOrJY8QI8yMW4IPBaGlhA_pb_x600.png'
    },
    {
      name: 'Grange', producer: 'Penfolds',
      country: 'AU', region: 'Barossa Valley', appellation: null,
      grapes: ['Syrah'], type: 'red', image: null
    },
    {
      name: 'Adrianna Vineyard Malbec', producer: 'Catena Zapata',
      country: 'AR', region: 'Mendoza', appellation: null,
      grapes: ['Malbec'], type: 'red', image: null
    },
    {
      name: 'Pouilly-Fumé Silex', producer: 'Didier Dagueneau',
      country: 'FR', region: 'Rhône Valley', appellation: 'Pouilly-Fumé AOC',
      grapes: ['Sauvignon Blanc'], type: 'white', image: null
    },
    {
      name: 'Grande Cuvée Blanc de Blancs', producer: 'Krug',
      country: 'FR', region: 'Champagne', appellation: 'Champagne AOC',
      grapes: ['Chardonnay'], type: 'sparkling', image: null
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
        country: countries[spec.country]._id,
        region: spec.region ? (regions[spec.region]?._id || null) : null,
        appellation: spec.appellation || undefined,
        grapes: grapeIds,
        type: spec.type,
        image: spec.image || null,
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
  let cellar = await Cellar.findOne({ user: demoUser._id, name: 'My First Cellar' });
  if (!cellar) {
    cellar = await Cellar.create({
      name: 'My First Cellar',
      description: 'A curated collection of fine wines',
      user: demoUser._id
    });
    console.log('  Cellar: My First Cellar');
  }

  const bottleSpecs = [
    { wine: 'Château Margaux',   vintage: '2015', count: 3,  price: 850, currency: 'USD', rating: 5, notes: 'Exceptional vintage. Deep ruby with cassis and cedar.' },
    { wine: 'Opus One',           vintage: '2018', count: 6,  price: 280, currency: 'USD', rating: 4, notes: 'Classic Napa blend. Firm tannins, needs 5 more years.' },
    { wine: 'Moët Brut Impérial', vintage: 'NV',   count: 12, price: 55,  currency: 'USD', rating: 4, notes: 'For celebrations.' },
    { wine: 'Grange',             vintage: '2017', count: 2,  price: 600, currency: 'USD', rating: 5, notes: "Australia's most iconic red wine." },
    { wine: 'Barolo Sperss',      vintage: '2016', count: 4,  price: 220, currency: 'USD', rating: 4, notes: 'King of Italian wines. Spectacular.' },
  ];

  for (const spec of bottleSpecs) {
    const wine = wineMap[spec.wine];
    if (!wine) { console.warn(`  Skipping bottle — wine not found: ${spec.wine}`); continue; }
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
      console.log(`  Bottle: ${spec.wine} ${spec.vintage} (×${spec.count})`);
    }
  }

  console.log('\nSeed complete!');
  console.log('  Admin:  admin@winecellar.com  /  Admin1234');
  console.log('  User:   user@winecellar.com   /  User1234');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
