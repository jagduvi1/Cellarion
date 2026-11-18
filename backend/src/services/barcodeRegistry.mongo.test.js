/**
 * Barcodes on the registry wine, against a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * A barcode belongs to one wine (a unique index on the array field), members'
 * evidence is counted as distinct owners (one member's twelve bottles are one
 * vote), a code moves only to a wine with MORE owners, a pending wine and a
 * demo account's bottles teach nothing, a catalogue's code is never moved by
 * members, a merge carries the codes to the keeper, a bulk edit's twelve saves
 * are one learning run (not twelve), the lookup still finds the
 * wine after every bottle that taught it is gone, and an ordinary wine read
 * never hands the codes out. Mocked models can show none of that.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_barcodes`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'barcode-registry-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'barcode-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mongoose = require('mongoose');

// The merge service pulls in much of the backend on its first require.
jest.setTimeout(30000);

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_barcodes'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/barcodeRegistry.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('barcodes on the registry wine (real MongoDB)', () => {
  let WineDefinition; let Bottle; let registry; let lookupBarcode; let reassignWineRefs;
  const oid = () => new mongoose.Types.ObjectId();
  const users = Array.from({ length: 8 }, oid);
  const demo = oid();
  const cellar = oid();
  const VIEWER = { userId: String(users[0]), roles: ['user'] };

  // Codes with a valid GS1 check digit, as utils/barcode.normalizeBarcode stores them.
  const C1 = '4006381333931';
  const C2 = '7310070001234';
  const C3 = '5000112637922';

  const wine = async (name, extra = {}) => {
    const _id = oid();
    await mongoose.connection.collection('winedefinitions').insertOne({ _id, name, producer: 'P', grapes: [], normalizedKey: `p|${name}|${_id}`, createdAt: new Date(), ...extra });
    return _id;
  };
  const bottle = (user, wineDefinition, barcode, extra = {}) => mongoose.connection.collection('bottles').insertOne({
    user, wineDefinition, barcode, cellar, bottleSize: '750ml', status: 'active', vintage: '2019', createdAt: new Date(), ...extra,
  });
  const holderOf = async (code) => WineDefinition.findOne({ 'barcodes.code': code }).select('+barcodes').lean();
  const entryOf = async (code) => { const h = await holderOf(code); return h ? { wine: String(h._id), ...h.barcodes.find((b) => b.code === code) } : null; };

  beforeAll(async () => {
    expect(new URL(URI).pathname).toBe('/cellarion_contract_barcodes');
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    // The lookup populates these, as the running app has them loaded.
    require('../models/Country'); require('../models/Region'); require('../models/Grape');
    WineDefinition = require('../models/WineDefinition');
    Bottle = require('../models/Bottle');
    await WineDefinition.init();
    await mongoose.connection.collection('users').insertMany([
      ...users.map((_id, i) => ({ _id, username: `u${i}`, email: `u${i}@example.invalid` })),
      { _id: demo, username: 'demo', email: 'demo@example.invalid', isDemo: true },
    ]);
    registry = require('./barcodeRegistry');
    ({ lookupBarcode } = require('./barcodeLookup'));
    ({ reassignWineRefs } = require('./wineMergeOps'));
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  test('one member\'s bottle attaches the code to the wine, with the bottle size and one owner', async () => {
    const w1 = await wine('Alpha');
    await bottle(users[0], w1, C1);
    await bottle(users[0], w1, C1); // the same member twice is still one owner
    expect(await registry.learnBarcode(C1)).toEqual({ action: 'added' });
    expect(await entryOf(C1)).toMatchObject({ wine: String(w1), owners: 1, bottleSize: '750ml', source: 'members' });

    await bottle(users[1], w1, C1);
    expect(await registry.learnBarcode(C1)).toEqual({ action: 'updated' });
    expect((await entryOf(C1)).owners).toBe(2);
  });

  test('a code moves only to a wine that more members\' bottles carry it on', async () => {
    const holder = (await entryOf(C1)).wine;
    const w2 = await wine('Beta');
    await bottle(users[2], w2, C1);
    expect(await registry.learnBarcode(C1)).toEqual({ action: 'updated' }); // 2 against 1: the holder still wins
    expect((await entryOf(C1)).wine).toBe(holder);

    await bottle(users[3], w2, C1);
    expect(await registry.learnBarcode(C1)).toEqual({ action: 'kept' }); // 2 against 2: it stays
    expect((await entryOf(C1)).wine).toBe(holder);
    await bottle(users[4], w2, C1);
    expect(await registry.learnBarcode(C1)).toEqual({ action: 'moved' });
    expect(await entryOf(C1)).toMatchObject({ wine: String(w2), owners: 3 });
    expect(await WineDefinition.countDocuments({ 'barcodes.code': C1 })).toBe(1);
  });

  test('a pending wine and a demo account\'s bottles teach nothing', async () => {
    const pending = await wine('Gamma', { pendingIdentity: true });
    for (const u of users.slice(0, 6)) await bottle(u, pending, C2);
    const w4 = await wine('Delta');
    for (let i = 0; i < 5; i++) await bottle(demo, w4, C2, { user: demo });
    expect(await registry.learnBarcode(C2)).toEqual({ action: 'none' });
    expect(await holderOf(C2)).toBeNull();
  });

  test('a catalogue\'s code is never moved by members', async () => {
    const shop = await wine('Epsilon');
    await WineDefinition.updateOne({ _id: shop }, { $push: { barcodes: { code: C3, source: 'shop catalogue', owners: 0 } } });
    const other = await wine('Zeta');
    for (const u of users) await bottle(u, other, C3);
    expect(await registry.learnBarcode(C3)).toEqual({ action: 'catalogue' });
    expect(await entryOf(C3)).toMatchObject({ wine: String(shop), source: 'shop catalogue' });
  });

  test('the database refuses a second wine for one code', async () => {
    const w = await wine('Eta');
    await expect(WineDefinition.updateOne({ _id: w }, { $push: { barcodes: { code: C3, source: 'members' } } }))
      .rejects.toMatchObject({ code: 11000 });
  });

  test('the lookup answers from the wine, also after every bottle that taught it is gone', async () => {
    const before = await lookupBarcode(C1, VIEWER);
    expect(before).toMatchObject({ owners: 3, bottleSize: '750ml' });
    await Bottle.deleteMany({ barcode: C1 });
    const after = await lookupBarcode(C1, VIEWER);
    expect(String(after.wine._id)).toBe(String(before.wine._id));
  });

  test('an ordinary wine read never carries the codes', async () => {
    const holder = await holderOf(C3);
    const plain = await WineDefinition.findById(holder._id).lean();
    expect(plain).not.toHaveProperty('barcodes');
    const excluding = await WineDefinition.findById(holder._id).select('-image').lean();
    expect(excluding).not.toHaveProperty('barcodes');
  });

  test('a merge carries the codes to the keeper; a code the keeper holds stays its own', async () => {
    const source = await wine('Theta');
    const keeper = await wine('Iota');
    await WineDefinition.updateOne({ _id: source }, { $push: { barcodes: { $each: [{ code: '4012345678901', source: 'members', owners: 2 }] } } });
    await WineDefinition.updateOne({ _id: keeper }, { $push: { barcodes: { code: '4098765432109', source: 'members', owners: 1 } } });
    await reassignWineRefs(source, keeper);
    const k = await WineDefinition.findById(keeper).select('+barcodes').lean();
    expect(k.barcodes.map((b) => b.code).sort()).toEqual(['4012345678901', '4098765432109']);
    const s = await WineDefinition.findById(source).select('+barcodes').lean();
    expect(s.barcodes).toBeUndefined();
  });

  test('a code finds its wine through the index, not by scanning the registry', async () => {
    const plan = JSON.stringify((await WineDefinition.find({ 'barcodes.code': C1 }).explain()).queryPlanner.winningPlan);
    expect(plan).toContain('IXSCAN');
    expect(plan).not.toContain('COLLSCAN');
  });

  test('a join that hides the member-hidden fields never carries the codes (as the wishlist list does)', async () => {
    const { MEMBER_WINE_HIDDEN_FIELDS } = require('../config/constants');
    const holder = await holderOf(C3);
    await mongoose.connection.collection('wishlistitems').insertOne({ _id: oid(), wineDefinition: holder._id });
    const [row] = await mongoose.connection.collection('wishlistitems').aggregate([
      { $match: { wineDefinition: holder._id } },
      { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wineDefinition' } },
      { $unwind: '$wineDefinition' },
      { $unset: MEMBER_WINE_HIDDEN_FIELDS.map((f) => `wineDefinition.${f}`) },
    ]).toArray();
    expect(row.wineDefinition).not.toHaveProperty('barcodes');
  });

  test('a code only one member taught is withdrawn once their bottle no longer carries it', async () => {
    const code = '4055555555550';
    const w = await wine('Nu');
    const { insertedId } = await bottle(users[0], w, code);
    expect(await registry.learnBarcode(code)).toEqual({ action: 'added' });
    // The member clears the barcode: their bottle no longer carries it.
    await Bottle.updateOne({ _id: insertedId }, { $unset: { barcode: 1 } });
    expect(await registry.learnBarcode(code)).toEqual({ action: 'withdrawn' });
    expect(await holderOf(code)).toBeNull();
  });

  test('a code several members confirmed stays when their bottles are gone, and one new bottle does not move it', async () => {
    const code = '4066666666660';
    const confirmed = await wine('Xi');
    await WineDefinition.updateOne({ _id: confirmed }, { $push: { barcodes: { code, source: 'members', owners: 5 } } });
    const elsewhere = await wine('Omicron');
    await bottle(users[1], elsewhere, code);
    expect(await registry.learnBarcode(code)).toEqual({ action: 'kept' });
    expect((await entryOf(code)).wine).toBe(String(confirmed));
  });

  test("a wine's bottles teach all their codes at once (a wine published, or a merge's keeper)", async () => {
    const codes = ['4077777777770', '4088888888880'];
    const w = await wine('Pi');
    for (const code of codes) await bottle(users[2], w, code);
    registry.learnWineBarcodesSoon(w, { via: 'test' });
    await settle(async () => (await Promise.all(codes.map(entryOf))).every(Boolean));
    for (const code of codes) expect((await entryOf(code)).wine).toBe(String(w));
  });

  const settle = async (done) => {
    for (let i = 0; i < 50; i++) { if (await done()) return; await new Promise((r) => setTimeout(r, 50)); }
    throw new Error('the background learning did not finish');
  };

  test('a case of twelve saved one by one is learned in one run plus at most one more', async () => {
    const code = '4022222222220';
    const w = await wine('Lambda');
    for (let i = 0; i < 12; i++) await bottle(users[6], w, code);
    const aggregate = jest.spyOn(Bottle, 'aggregate');
    try {
      for (let i = 0; i < 12; i++) registry.learnBarcodeSoon(code, { via: 'test' });
      await settle(async () => (await entryOf(code)) !== null);
      await new Promise((r) => setTimeout(r, 300));
      expect(aggregate.mock.calls.length).toBeLessThanOrEqual(2);
      expect(await entryOf(code)).toMatchObject({ wine: String(w), owners: 1 });
    } finally {
      aggregate.mockRestore();
    }
  });

  test("a restored cellar's codes are taught one after another", async () => {
    const codes = ['4033333333330', '4044444444440'];
    const w = await wine('Mu');
    for (const code of codes) await bottle(users[7], w, code);
    registry.learnBarcodesSoon([...codes, codes[0], null]);
    await settle(async () => (await Promise.all(codes.map(entryOf))).every(Boolean));
    for (const code of codes) expect((await entryOf(code)).wine).toBe(String(w));
  });

  test('the backfill teaches every code once and is safe to run again', async () => {
    const w = await wine('Kappa');
    await bottle(users[5], w, '4011111111110');
    const first = await registry.backfillBarcodes();
    expect(first.codes).toBeGreaterThan(0);
    const second = await registry.backfillBarcodes();
    expect(second.added || 0).toBe(0);
  });
});
