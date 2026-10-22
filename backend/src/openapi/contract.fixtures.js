/**
 * Seed data for the API contract test (openapi/contract.test.js): a small,
 * complete world written through the real Mongoose models into a throwaway
 * database, so every documented endpoint answers from real queries.
 *
 * Two members: `alice` (the caller) owns "Home" with a wine fridge (cabinet)
 * and a grid rack, and is an editor of `bob`'s "Shared" cellar. Bottles cover
 * the states a client meets: placed in each rack type, a free-text place, one
 * waiting on a wine request, drunk and on order. One API token per scope.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineRequest = require('../models/WineRequest');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const PersonalDataKey = require('../models/PersonalDataKey');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const Notification = require('../models/Notification');
const ApiToken = require('../models/ApiToken');
const ClimateDevice = require('../models/ClimateDevice');
const ExchangeRateSnapshot = require('../models/ExchangeRateSnapshot');

const PASSWORD = 'Contract-Test-Passw0rd!';
const PHOTO = (n) => `/api/uploads/processed/0000000${n}-aaaa-4bbb-8ccc-dddddddddddd.webp`;

async function token(user, name, scopes, extra = {}) {
  const raw = ApiToken.generateToken();
  const doc = await ApiToken.create({ user: user._id, name, tokenHash: ApiToken.hashToken(raw), scopes, ...extra });
  return { raw, doc };
}

/** Seed everything; returns the ids and raw tokens the test needs. */
async function seedContractData() {
  const year = new Date().getUTCFullYear();

  // The day's exchange rates, so no request ever reaches the rate API.
  await ExchangeRateSnapshot.create({
    date: new Date().toISOString().slice(0, 10),
    rates: { USD: 1, EUR: 0.92, SEK: 10.5, GBP: 0.79 },
    fetchedAt: new Date(),
  });

  const alice = await User.create({ username: 'alice', email: 'alice@contract.test', password: PASSWORD });
  const bob = await User.create({ username: 'bob', email: 'bob@contract.test', password: PASSWORD });
  // No cellars at all: the empty answers.
  const carol = await User.create({ username: 'carol', email: 'carol@contract.test', password: PASSWORD });

  const france = await Country.create({ name: 'France', normalizedName: 'france', createdBy: alice._id });
  const pauillac = await Region.create({ name: 'Pauillac', normalizedName: 'pauillac', country: france._id, createdBy: alice._id });
  const cab = await Grape.create({ name: 'Cabernet Sauvignon', normalizedName: 'cabernet sauvignon', createdBy: alice._id });
  const merlot = await Grape.create({ name: 'Merlot', normalizedName: 'merlot', createdBy: alice._id });
  const sauvignon = await Grape.create({ name: 'Sauvignon Blanc', normalizedName: 'sauvignon blanc', createdBy: alice._id });

  const red = await WineDefinition.create({
    name: 'Château Exemple', producer: 'Château Exemple', type: 'red',
    country: france._id, region: pauillac._id, appellation: 'Pauillac', grapes: [cab._id, merlot._id],
    normalizedKey: 'chateau exemple|chateau exemple|pauillac', createdBy: alice._id, image: PHOTO(1),
    aiProfile: {
      body: 'full', acidity: 'medium', sweetness: 'dry', tannin: 'high',
      flavors: ['blackcurrant', 'cedar', 'graphite'], foodPairings: ['lamb', 'aged cheese'],
      description: 'Never sent to integrations.',
    },
  });
  const white = await WineDefinition.create({
    name: 'Exemple Blanc', producer: 'Domaine Exemple', type: 'white',
    country: france._id, grapes: [sauvignon._id],
    normalizedKey: 'exemple blanc|domaine exemple|', createdBy: alice._id,
  });

  // A reviewed drink window for the red 2015 (the bottle has none of its own).
  await WineVintageProfile.create({
    wineDefinition: red._id, vintage: '2015', status: 'reviewed',
    earlyFrom: 2022, peakFrom: year - 1, peakUntil: year + 6, lateUntil: year + 12,
  });

  const home = await Cellar.create({ name: 'Home', user: alice._id, description: 'The basement' });
  const shared = await Cellar.create({ name: 'Shared', user: bob._id, members: [{ user: alice._id, role: 'editor' }] });

  const pendingRequest = await WineRequest.create({
    user: alice._id, wineName: 'Unlisted Cuvée', producer: 'Small Grower', status: 'pending',
  });

  const common = { user: alice._id, cellar: home._id };
  const b1 = await Bottle.create({
    ...common, wineDefinition: red._id, vintage: '2015', bottleSize: '750ml',
    price: 350, currency: 'SEK', rating: 92, ratingScale: '100',
    notes: 'For a birthday', purchaseDate: new Date(Date.UTC(2024, 4, 1)), purchaseLocation: 'Wine shop',
  });
  const b2 = await Bottle.create({ ...common, wineDefinition: red._id, vintage: '2018', bottleSize: '750ml', price: 39, currency: 'EUR' });
  const b3 = await Bottle.create({ ...common, wineDefinition: white._id, vintage: '2022', bottleSize: '750ml', location: 'Kitchen, box 3' });
  const b4 = await Bottle.create({ ...common, wineDefinition: null, pendingWineRequest: pendingRequest._id, vintage: '2020', bottleSize: '1500ml' });
  const drunk = await Bottle.create({
    ...common, wineDefinition: white._id, vintage: '2019', status: 'drank',
    consumedAt: new Date(), consumedReason: 'drank',
  });
  const ordered = await Bottle.create({ ...common, wineDefinition: red._id, vintage: '2020', status: 'ordered' });
  const consumable = await Bottle.create({ ...common, wineDefinition: white._id, vintage: '2023', bottleSize: '750ml' });
  // Its own window says it is past its peak: the urgency ladder lists it.
  const late = await Bottle.create({
    ...common, wineDefinition: white._id, vintage: '2016', bottleSize: '750ml', price: 20, currency: 'EUR',
    drinkFrom: 2017, peakFrom: 2018, peakUntil: year - 2, drinkTo: year + 1,
  });
  const bobs = await Bottle.create({ user: bob._id, cellar: shared._id, wineDefinition: white._id, vintage: '2021' });

  // A wine fridge: 2 shelves × 3 bottles; and a 2 × 3 grid.
  const fridge = await Rack.create({
    cellar: home._id, user: alice._id, name: 'Wine fridge', type: 'cabinet', rows: 2, cols: 3,
    typeConfig: { shelfRows: [1, 1] }, slots: [{ position: 5, bottle: b1._id }],
  });
  const grid = await Rack.create({
    cellar: home._id, user: alice._id, name: 'Grid', type: 'grid', rows: 2, cols: 3,
    slots: [{ position: 4, bottle: b2._id }],
  });

  // Personal data: one bottle-level entry, one wine-level entry by a member.
  const closure = await PersonalDataKey.create({ user: alice._id, name: 'Closure', nameKey: 'closure', type: 'text' });
  const abv = await PersonalDataKey.create({ user: bob._id, name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%' });
  await PersonalDataEntry.create({ author: alice._id, key: closure._id, targetType: 'bottle', bottle: b1._id, value: 'cork' });
  await PersonalDataEntry.create({ author: bob._id, key: abv._id, targetType: 'wine', wineDefinition: white._id, value: 13.5 });

  await Notification.create({ user: alice._id, type: 'restock_alert', title: 'Restock Suggestion', message: 'Time to restock?', link: '/restock' });
  await Notification.create({ user: alice._id, type: 'restock_alert', title: 'Older one', message: 'Read already', link: '/restock', read: true });

  const tokens = {
    read: await token(alice, 'contract read', ['read']),
    consume: await token(alice, 'contract consume', ['consume']),
    write: await token(alice, 'contract write', ['write']),
    climate: await token(alice, 'contract climate', ['climate']),
    // A climate token whose device is gone: ingest answers 404.
    climateOrphan: await token(alice, 'contract climate orphan', ['climate']),
    revoked: await token(alice, 'contract revoked', ['read'], { revokedAt: new Date() }),
    selfRevoke: await token(alice, 'contract self-revoke', ['read']),
    bobRead: await token(bob, 'bob read', ['read']),
    carolRead: await token(carol, 'carol read', ['read']),
  };
  await ClimateDevice.create({ user: alice._id, name: 'Fridge sensor', token: tokens.climate.doc._id, cellar: home._id });

  return {
    users: { alice, bob, carol },
    cellars: { home, shared },
    racks: { fridge, grid },
    wines: { red, white },
    bottles: { b1, b2, b3, b4, drunk, ordered, consumable, late, bobs },
    tokens,
  };
}

/** Refuse to touch anything but a throwaway contract database. */
function assertContractDb(conn = mongoose.connection) {
  if (!/^cellarion_contract/.test(conn.name || '')) {
    throw new Error(`Contract tests only run against a cellarion_contract* database, not "${conn.name}"`);
  }
}

module.exports = { seedContractData, assertContractDb, PASSWORD };
