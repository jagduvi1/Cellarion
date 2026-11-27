/**
 * A cellar-file import that asks no AI, on a server that checks imported wines
 * before they are public — /validate then /confirm against a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * The whole promise is in what ends up stored. Every row the registry does not
 * know becomes a bottle at once, on a wine built from the file's own words
 * that only its owner and the curators can see; a type the file does not state
 * is stored as none, not as red; a country the file does not state comes from
 * the appellation taxonomy; the same file imported twice mints nothing twice;
 * and once a curator has checked a wine, the next member's file lands on it.
 * No call reaches an AI provider at any point. Mocked models can show none of
 * that end to end.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_import`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'import-file-only-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'import-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';
// No provider key: the import has no AI to ask.
delete process.env.ANTHROPIC_API_KEY;

// The Meilisearch client is ESM-only (Jest cannot load it); matching falls back to MongoDB.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));
// Any identification call would be a failure of the test's premise.
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn(async () => { throw new Error('the import called the AI'); }) }));

const mongoose = require('mongoose');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

jest.setTimeout(90000);

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_import'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/import.fileOnly.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('an import with no AI, on a server that checks imported wines (real MongoDB)', () => {
  let server; let base; let WineDefinition; let Bottle; let importPolicy; let pendingOps; let visibility;
  const { identifyWineFromText } = require('../services/labelScan');
  const oid = () => new mongoose.Types.ObjectId();
  const [ANNA, BEN, CURATOR, SEEDER] = Array.from({ length: 4 }, oid);
  const cellars = { [ANNA]: oid(), [BEN]: oid() };

  const post = async (user, path, items) => {
    const res = await fetch(`${base}/api/bottles/import/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt.sign({ id: String(user), roles: ['user'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`,
      },
      body: JSON.stringify({ cellarId: String(cellars[user]), items }),
    });
    return { status: res.status, body: await res.json() };
  };
  // What the review screen sends for a row the member accepts as it is offered
  // (frontend utils/importPayload.buildImportItem).
  const accept = (r) => ({
    ...r.item,
    ...(r.status === 'ai_new' ? { aiWine: r.aiProposed } : { wineDefinition: r.matches[0].wineId }),
  });
  const importFile = async (user, rows) => {
    const validated = await post(user, 'validate', rows);
    expect(validated.status).toBe(200);
    const confirmed = await post(user, 'confirm', validated.body.results.map(accept));
    expect(confirmed.status).toBe(200);
    return { validated: validated.body, confirmed: confirmed.body };
  };

  const FILE = [
    // No country in the file: the appellation taxonomy knows it.
    { wineName: 'Barolo Bussia', producer: 'Cantina Esempio', appellation: 'Barolo', vintage: '2016', type: 'red' },
    // No type in the file.
    { wineName: 'Riesling Kabinett', producer: 'Weingut Beispiel', country: 'Germany', region: 'Mosel', vintage: '2021' },
    { wineName: 'Riesling Kabinett', producer: 'Weingut Beispiel', country: 'Germany', region: 'Mosel', vintage: '2020' },
  ];

  beforeAll(async () => {
    expect(new URL(URI).pathname).toBe('/cellarion_contract_import');
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    require('../models/Region'); require('../models/Grape');
    const Country = require('../models/Country');
    const Appellation = require('../models/Appellation');
    WineDefinition = require('../models/WineDefinition');
    Bottle = require('../models/Bottle');
    await WineDefinition.init();
    const db = mongoose.connection;
    await db.collection('users').insertMany([ANNA, BEN, CURATOR].map((_id, i) => ({ _id, username: `u${i}`, email: `u${i}@example.invalid` })));
    await db.collection('cellars').insertMany([ANNA, BEN].map((user) => ({ _id: cellars[user], user, name: 'Cellar', members: [], deletedAt: null })));
    const italy = await Country.create({ name: 'Italy', normalizedName: 'italy', createdBy: SEEDER });
    await Appellation.create({ name: 'Barolo', normalizedName: 'barolo', country: italy._id, createdBy: SEEDER });

    importPolicy = require('../config/importPolicy');
    importPolicy.set({ checkNewWines: true });
    pendingOps = require('../services/pendingWineOps');
    visibility = require('../services/wineVisibility');

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/bottles/import', require('./import'));
    server = http.createServer(app).listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (importPolicy) importPolicy.set({});
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let barolo; let riesling;

  test('every row the registry does not know is offered as a new wine from the file, and imports', async () => {
    const { validated, confirmed } = await importFile(ANNA, FILE);

    expect(validated.results.map((r) => r.status)).toEqual(['ai_new', 'ai_new', 'ai_new']);
    expect(validated.results[0].aiProposed).toMatchObject({ name: 'Barolo Bussia', producer: 'Cantina Esempio', country: 'Italy' });
    expect(confirmed).toMatchObject({ created: 3, errors: [], uncheckedCount: 2, pendingIdentityCount: 0 });
    expect(await Bottle.countDocuments({ user: ANNA })).toBe(3);
    expect(identifyWineFromText).not.toHaveBeenCalled();
  });

  test('the wines wait for a curator: only their owner and curators can see them', async () => {
    const wines = await WineDefinition.find({ createdBy: ANNA }).populate('country', 'name').lean();
    expect(wines).toHaveLength(2);
    for (const w of wines) {
      expect(w).toMatchObject({ uncheckedIdentity: true, pendingIdentity: true, createdVia: 'import' });
      expect(w.normalizedKey.startsWith(`unchecked~${ANNA}:`)).toBe(true);
    }
    barolo = wines.find((w) => w.name === 'Barolo Bussia');
    riesling = wines.find((w) => w.name === 'Riesling Kabinett');
    // The country the file did not state, and no type where the file states none.
    expect(barolo.country.name).toBe('Italy');
    expect(barolo.type).toBe('red');
    expect(riesling.type ?? null).toBeNull();
    // Both vintages of the Riesling sit on the one wine.
    expect(await Bottle.countDocuments({ wineDefinition: riesling._id })).toBe(2);

    expect(await visibility.findVisibleWine(String(barolo._id), { userId: String(ANNA), roles: ['user'] })).not.toBeNull();
    expect(await visibility.findVisibleWine(String(barolo._id), { userId: String(CURATOR), roles: ['somm'] })).not.toBeNull();
    expect(await visibility.findVisibleWine(String(barolo._id), { userId: String(BEN), roles: ['user'] })).toBeNull();
  });

  test('importing the same file again adds the bottles and mints no wine twice', async () => {
    const { confirmed } = await importFile(ANNA, FILE);
    expect(confirmed.created).toBe(3);
    expect(confirmed.errors).toEqual([]);
    expect(await WineDefinition.countDocuments({ createdBy: ANNA })).toBe(2);
    expect(await Bottle.countDocuments({ user: ANNA })).toBe(6);
  });

  test('another member\'s file of the same wine gets its own waiting row, never the first member\'s', async () => {
    const { confirmed } = await importFile(BEN, [FILE[1]]);
    expect(confirmed).toMatchObject({ created: 1, uncheckedCount: 1 });
    const own = await WineDefinition.findOne({ createdBy: BEN }).lean();
    expect(String(own._id)).not.toBe(String(riesling._id));
    expect(own.uncheckedIdentity).toBe(true);
    await Bottle.deleteMany({ user: BEN });
    await WineDefinition.deleteOne({ _id: own._id });
  });

  test('once a curator has checked a wine, the next member\'s file lands on it', async () => {
    const fixed = await pendingOps.applyPendingFix(await WineDefinition.findById(riesling._id), { type: 'white', identityChecked: true }, String(CURATOR));
    expect(fixed).toMatchObject({ ok: true, promoted: true });

    const { validated, confirmed } = await importFile(BEN, [FILE[1]]);
    expect(validated.results[0].status).not.toBe('ai_new');
    expect(confirmed).toMatchObject({ created: 1, errors: [] });
    expect(confirmed.uncheckedCount).toBeUndefined();
    const [bottle] = await Bottle.find({ user: BEN }).lean();
    expect(String(bottle.wineDefinition)).toBe(String(riesling._id));
    expect(await WineDefinition.countDocuments({ createdBy: BEN })).toBe(0);
  });

  test('with the check switched off, a new wine is published as it is created', async () => {
    importPolicy.set({ checkNewWines: false });
    const { confirmed } = await importFile(BEN, [{ wineName: 'Chianti Classico', producer: 'Fattoria Esempio', country: 'Italy', type: 'red', vintage: '2019' }]);
    expect(confirmed).toMatchObject({ created: 1, errors: [] });
    expect(confirmed.uncheckedCount).toBeUndefined();
    const wine = await WineDefinition.findOne({ createdBy: BEN }).lean();
    expect(wine).toMatchObject({ pendingIdentity: false, uncheckedIdentity: false, type: 'red' });
    importPolicy.set({ checkNewWines: true });
  });

  test('a wine whose file states no type is stored with none, also when it is published at once', async () => {
    importPolicy.set({ checkNewWines: false });
    const { confirmed } = await importFile(BEN, [{ wineName: 'Soave Classico', producer: 'Cantina Esempio', country: 'Italy', vintage: '2022' }]);
    expect(confirmed).toMatchObject({ created: 1, errors: [] });
    const wine = await WineDefinition.findOne({ name: 'Soave Classico' }).lean();
    expect(wine.pendingIdentity).toBe(false);
    // Not "red": a white counted as red is wrong for everyone who finds it.
    expect(wine.type ?? null).toBeNull();
    importPolicy.set({ checkNewWines: true });
  });

  test('a country column that names no country does not cost the row: the registry\u2019s answer is used', async () => {
    const { validated, confirmed } = await importFile(ANNA, [
      { wineName: 'Barolo Cannubi', producer: 'Cantina Esempio', country: 'Piedmont', appellation: 'Barolo', type: 'red', vintage: '2017' },
    ]);
    expect(validated.results[0].aiProposed.country).toBe('Italy');
    expect(confirmed).toMatchObject({ created: 1, errors: [] });
  });

  test('a curator importing their own file is not handed another member\u2019s waiting wine', async () => {
    const SOMM = oid();
    cellars[SOMM] = oid();
    await mongoose.connection.collection('users').insertOne({ _id: SOMM, username: 'somm', email: 'somm@example.invalid' });
    await mongoose.connection.collection('cellars').insertOne({ _id: cellars[SOMM], user: SOMM, name: 'Somm cellar', members: [], deletedAt: null });
    const sommPost = async (path, items) => {
      const res = await fetch(`${base}/api/bottles/import/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt.sign({ id: String(SOMM), roles: ['user', 'somm'] }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`,
        },
        body: JSON.stringify({ cellarId: String(cellars[SOMM]), items }),
      });
      return res.json();
    };
    // Anna's Barolo Bussia still waits for a check.
    expect(await WineDefinition.exists({ _id: barolo._id, uncheckedIdentity: true })).not.toBeNull();

    const validated = await sommPost('validate', [FILE[0]]);
    expect(validated.results[0].status).toBe('ai_new');
    expect(JSON.stringify(validated.results[0].matches)).not.toContain(String(barolo._id));

    const confirmed = await sommPost('confirm', validated.results.map(accept));
    expect(confirmed).toMatchObject({ created: 1, errors: [] });
    const [bottle] = await Bottle.find({ user: SOMM }).lean();
    expect(String(bottle.wineDefinition)).not.toBe(String(barolo._id));
  });
});
