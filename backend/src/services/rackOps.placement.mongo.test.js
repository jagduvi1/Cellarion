/**
 * What a placement leaves behind when it is refused, and when the bottle
 * leaves the cellar while it is being placed — the REAL models on a REAL
 * MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * services/rackOps.test.js mocks every model, so it pins which calls are
 * made, not what MongoDB does with them. Three things here only a database
 * can show: that the pull from the other rack hands back the slot the bottle
 * sat in (a findOneAndUpdate with an $elemMatch projection), that the
 * put-back's filter refuses a slot taken meanwhile, and that the unique
 * slots.bottle index and the document version turn the races into clean
 * refusals. Each race is staged by doing the other request's write inside the
 * rack's own save, the one point where it can land between this placement's
 * read of the bottle and its write.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_rack_placement`, dropped before and after. Skipped
 * without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rack-placement-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'rack-placement-meili-key-01234567';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here
// searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mongoose = require('mongoose');
const { assertContractDb } = require('../openapi/contract.fixtures');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_rack_placement'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/rackOps.placement.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('placing a bottle in a rack slot (real MongoDB)', () => {
  let User; let Cellar; let Rack; let Bottle; let rackOps; let bottleOps;
  let user; let A; let B; let req;

  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    User = require('../models/User');
    Cellar = require('../models/Cellar');
    Rack = require('../models/Rack');
    Bottle = require('../models/Bottle');
    await Rack.init(); // the unique slots.bottle index
    rackOps = require('./rackOps');
    bottleOps = require('./bottleOps');
    user = await User.create({ username: 'racer', email: 'racer@contract.test', password: 'Contract-Test-Passw0rd!' });
    A = await Cellar.create({ name: 'A', user: user._id });
    B = await Cellar.create({ name: 'B', user: user._id });
    req = { user: { id: String(user._id), roles: ['user'] }, headers: {} };
  }, 120000);

  afterAll(async () => {
    // The audit rows of the last test are written after it returns.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (mongoose.connection.readyState === 1) {
      assertContractDb();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  const bottle = (cellar, vintage) => Bottle.create({ user: user._id, cellar: cellar._id, wineDefinition: null, vintage });
  const grid = (name, slots = []) => Rack.create({ cellar: A._id, user: user._id, name, type: 'grid', rows: 2, cols: 3, slots });
  const slotsOf = async (rackId) => (await Rack.findById(rackId).lean()).slots.map((s) => `${s.position}:${String(s.bottle)}`).sort();
  const at = (pos, b) => `${pos}:${String(b._id)}`;

  test('a bottle placed in another rack leaves the rack it was in; an id in upper case is the same bottle', async () => {
    const b = await bottle(A, '2015');
    const r1 = await grid('R1', [{ position: 3, bottle: b._id }]);
    const r2 = await grid('R2');
    const res = await rackOps.placeBottleInRack(await Rack.findById(r2._id), 2, String(b._id), req);
    expect(res.error).toBeUndefined();
    expect(await slotsOf(r1._id)).toEqual([]);
    expect(await slotsOf(r2._id)).toEqual([at(2, b)]);

    const again = await rackOps.placeBottleInRack(await Rack.findById(r2._id), 4, String(b._id).toUpperCase(), req);
    expect(again.error).toBeUndefined();
    expect(await slotsOf(r2._id)).toEqual([at(4, b)]);
  });

  test('a placement refused by a concurrent write leaves the bottle in the slot it was taken from', async () => {
    const b = await bottle(A, '2016');
    const r1 = await grid('R3', [{ position: 3, bottle: b._id }]);
    const r2 = await grid('R4');
    const stale = await Rack.findById(r2._id);
    const other = await Rack.findById(r2._id);
    other.name = 'R4 renamed';
    await other.save(); // moves the version on under `stale`
    const res = await rackOps.placeBottleInRack(stale, 2, String(b._id), req);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(await slotsOf(r1._id)).toEqual([at(3, b)]);
    expect(await slotsOf(r2._id)).toEqual([]);
  });

  test('a slot taken meanwhile is not overwritten by the put-back', async () => {
    const b = await bottle(A, '2017');
    const c = await bottle(A, '2018');
    const r1 = await grid('R5', [{ position: 3, bottle: b._id }]);
    const r2 = await grid('R6');
    const target = await Rack.findById(r2._id);
    target.save = async () => { // slot 3 of R5 is filled, and this save loses its race
      await Rack.updateOne({ _id: r1._id }, { $push: { slots: { position: 3, bottle: c._id } } });
      throw Object.assign(new Error('v'), { name: 'VersionError' });
    };
    const res = await rackOps.placeBottleInRack(target, 2, String(b._id), req);
    expect(res.error).toMatchObject({ status: 409 });
    expect(await slotsOf(r1._id)).toEqual([at(3, c)]);
    expect(await Rack.countDocuments({ 'slots.bottle': b._id })).toBe(0);
  });

  test('a bottle moved to another cellar while it is placed is in no rack, and the bottle it pushed out is back in its slot', async () => {
    const b = await bottle(A, '2019');
    const d = await bottle(A, '2020');
    const r = await grid('R7', [{ position: 2, bottle: d._id }]);
    const target = await Rack.findById(r._id);
    const realSave = target.save.bind(target);
    target.save = async (...args) => {
      const moved = await rackOps.moveBottleToCellar(await Bottle.findById(b._id), A, B, req);
      expect(moved.error).toBeUndefined();
      return realSave(...args);
    };
    const res = await rackOps.placeBottleInRack(target, 2, String(b._id), req);
    expect(res.error).toMatchObject({ status: 409, code: 'conflict' });
    expect(String((await Bottle.findById(b._id)).cellar)).toBe(String(B._id));
    expect(await slotsOf(r._id)).toEqual([at(2, d)]);
    expect(await Rack.countDocuments({ 'slots.bottle': b._id })).toBe(0);
  });

  test('a bottle drunk while it is placed is not left in a slot', async () => {
    const b = await bottle(A, '2021');
    const r = await grid('R8');
    const target = await Rack.findById(r._id);
    const realSave = target.save.bind(target);
    target.save = async (...args) => {
      await Bottle.updateOne({ _id: b._id }, { $set: { status: 'drank', consumedAt: new Date(), consumedReason: 'drank' } });
      return realSave(...args);
    };
    const res = await rackOps.placeBottleInRack(target, 1, String(b._id), req);
    expect(res.error).toMatchObject({ status: 409 });
    expect(await slotsOf(r._id)).toEqual([]);
  });

  test('a bottle drunk while it was out of its rack is not put back to stay', async () => {
    const b = await bottle(A, '2022');
    const r1 = await grid('R9', [{ position: 3, bottle: b._id }]);
    const r2 = await grid('R10');
    const target = await Rack.findById(r2._id);
    target.save = async () => { // the bottle is drunk, and this save loses its race
      await Bottle.updateOne({ _id: b._id }, { $set: { status: 'drank', consumedAt: new Date(), consumedReason: 'drank' } });
      throw Object.assign(new Error('v'), { name: 'VersionError' });
    };
    const res = await rackOps.placeBottleInRack(target, 2, String(b._id), req);
    expect(res.error).toMatchObject({ status: 409 });
    expect(await Rack.countDocuments({ 'slots.bottle': b._id })).toBe(0);
    expect(await slotsOf(r1._id)).toEqual([]);
  });

  test('a slot saved for a bottle while it was being deleted does not outlive the bottle', async () => {
    const b = await bottle(A, '2023');
    const r = await grid('R11');
    const doc = await Bottle.findById(b._id);
    const realDelete = doc.deleteOne.bind(doc);
    doc.deleteOne = async (...args) => { // a placement lands after the racks were swept and before the delete
      await Rack.updateOne({ _id: r._id }, { $push: { slots: { position: 1, bottle: b._id } } });
      return realDelete(...args);
    };
    const res = await bottleOps.removeBottleCascade(doc, req, 'bottle.delete');
    expect(res.error).toBeUndefined();
    expect(await Bottle.countDocuments({ _id: b._id })).toBe(0);
    expect(await slotsOf(r._id)).toEqual([]);
  });
});
