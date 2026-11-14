/**
 * A Champagne cru typed into the appellation, on every path that writes a
 * registry wine: the REAL app against a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * A wine's identity key is producer:name:appellation. In Champagne the cru
 * rates the village, so "Champagne Grand Cru" is the appellation Champagne
 * plus a tier (docs/wine-fields.md). While the cru form was stored as an
 * appellation of its own, the same wine could be written under two keys and
 * the duplicate guard did not see the twin. The rule has to hold on EVERY
 * write path, or the one that forgets it mints the next twin:
 *   - the stored appellation is "Champagne";
 *   - normalizedKey and canonicalKey both end in "champagne";
 *   - the cru is among the wine's tiers, beside the tier it already had;
 *   - a wine typed with the cru FINDS the wine stored as "Champagne".
 * Each path is driven the way a client drives it (REST route or MCP tool) and
 * the stored document is read back raw. Every test runs twice: with "Champagne
 * Grand Cru" / "Champagne Premier Cru" on the curated appellation list, where
 * the resolver adopts them (a registry before scripts/align-cru-appellations.js
 * has run), and without them (after it has).
 *
 * Cognac's "Grande Champagne" and a value naming a village are the traps:
 * they must go through as typed.
 *
 * Every request stays on the test stack: FRONTEND_URL is a dead local address
 * and fetch follows no redirect.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_cruwrite`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cru-write-paths-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'cru-meili-key-0123456789abcdef01';
process.env.MEILI_URL = 'http://127.0.0.1:1';
process.env.FRONTEND_URL = 'http://127.0.0.1:9';

// The Meilisearch client is ESM-only (Jest cannot load it); no path here
// searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { seedContractData, assertContractDb } = require('../openapi/contract.fixtures');
const { generateWineKey, pendingWineKey, draftWineKey, stripSweetnessKeySegment } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_cruwrite'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/champagneCru.writePaths.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');
// Each test drives several requests through the whole app.
jest.setTimeout(60000);

// Invented producers and cuvées, far enough apart that no two score as the
// same wine in the fuzzy stage.
const HOUSES = ['Albrand', 'Bertholon', 'Corbinet', 'Delacourt', 'Eymardin', 'Fauchelot', 'Girodet', 'Hautval', 'Isnardy', 'Jourdel',
  'Kerlanec', 'Lamourel', 'Marchaisy', 'Noirotte', 'Orsandre', 'Pelissac', 'Quenardy', 'Roussange', 'Sauvagny', 'Taillandes',
  'Urbanet', 'Vasselot', 'Wuillemet', 'Xanthier', 'Yvernaud', 'Zellerin', 'Ambroisy', 'Bonnefoux', 'Castagnol', 'Dumontel',
  'Escoffin', 'Fontanges', 'Gauthrin', 'Herbelot', 'Imbertin', 'Joubarde', 'Kleberon', 'Lhermitte', 'Mouginot', 'Naudinet',
  'Ozanneau', 'Pradelle', 'Quillard', 'Rochebrun', 'Sabatoux', 'Thevenard', 'Usseglio', 'Vigneraud', 'Waltzing', 'Ybarnet',
  'Zamparel', 'Aubriotte', 'Brochand', 'Chastenoy', 'Daviaudin', 'Estienne', 'Froidure', 'Grimbert', 'Houdaille', 'Icardine',
  'Jaubertin', 'Kervadec', 'Loiseleur', 'Mathurin', 'Nicolardot', 'Oudinet', 'Perraudin', 'Quinault', 'Ravinelle', 'Soubeyran',
  'Tisserand', 'Uzanne', 'Verdillon', 'Wattelier', 'Yzernay', 'Zuccarel', 'Arnaudet', 'Bousquier', 'Clavellin', 'Destouches',
  'Esperandieu', 'Fargeot', 'Guilhem', 'Hugonnet'];
const CUVEES = ['Aurore', 'Brume', 'Clairière', 'Dentelle', 'Écume', 'Falaise', 'Givre', 'Horizon', 'Ivoire', 'Jardin',
  'Kiosque', 'Lumière', 'Matinale', 'Nuage', 'Orage', 'Prairie', 'Quartz', 'Rivage', 'Sillage', 'Tonnerre',
  'Ultime', 'Voilure', 'Zénith', 'Alizé', 'Bocage', 'Cascade', 'Dune', 'Éclipse', 'Fougère', 'Granit',
  'Hirondelle', 'Insolite', 'Jonquille', 'Kermesse', 'Lisière', 'Mirage', 'Nénuphar', 'Opaline', 'Pivoine', 'Quiétude',
  'Rosée', 'Solstice', 'Tilleul', 'Ombrage', 'Vendange', 'Aubépine', 'Bruyère', 'Coquelicot', 'Douceur', 'Embrun',
  'Feuillage', 'Glycine', 'Hameau', 'Idylle', 'Jasmin', 'Lavande', 'Mésange', 'Noisette', 'Oseraie', 'Passerelle',
  'Ruisseau', 'Sentier', 'Treille', 'Verger', 'Bergerie', 'Chèvrefeuille', 'Églantine', 'Framboise', 'Garrigue', 'Hermine',
  'Ardoise', 'Bourrasque', 'Charmille', 'Draperie', 'Estuaire', 'Flânerie', 'Giboulée', 'Halliers', 'Javelle', 'Luzerne',
  'Marjolaine', 'Nacelle', 'Oriflamme', 'Pénombre'];

describeWithMongo('a Champagne cru typed into the appellation, on every write path (real MongoDB)', () => {
  let server; let base; let world; let tokens; let admin; let allTools; let db;
  let WineDefinition; let Appellation; let Classification; let ops; let france; let champagneRegion;
  let filers = [];
  let n = 0;

  /** A fresh invented identity. */
  const fresh = () => { const i = n; n += 1; return { producer: `Maison ${HOUSES[i]}`, name: `Cuvée ${CUVEES[i]}` }; };

  beforeAll(async () => {
    await mongoose.connect(URI);
    assertContractDb();
    await mongoose.connection.dropDatabase();
    world = await seedContractData();
    db = mongoose.connection.db;
    WineDefinition = require('../models/WineDefinition');
    Appellation = require('../models/Appellation');
    Classification = require('../models/Classification');
    ops = require('../services/classificationOps');
    const User = require('../models/User');
    const Country = require('../models/Country');
    const Region = require('../models/Region');
    admin = await User.create({ username: 'root', email: 'root@contract.test', password: 'Contract-Test-Passw0rd!', roles: ['user', 'admin', 'somm'] });
    france = await Country.findOne({ normalizedName: 'france' });
    champagneRegion = await Region.create({ name: 'Champagne', normalizedName: 'champagne', country: france._id, createdBy: admin._id });
    await Region.create({ name: 'Cognac', normalizedName: 'cognac', country: france._id, createdBy: admin._id });
    await ops.seedClassifications();
    await Appellation.create({ name: 'Champagne', normalizedName: 'champagne', country: france._id, region: champagneRegion._id, createdBy: admin._id });
    const sign = (u, roles) => jwt.sign({ id: String(u._id), roles }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    tokens = { member: sign(world.users.alice, ['user']), admin: sign(admin, ['user', 'admin', 'somm']) };
    // A member files a few suggestions a day: each correction below has its own filer.
    filers = [world.users.alice, world.users.bob, world.users.carol, admin].map((u) => sign(u, ['user']));
    server = http.createServer(require('../app')).listen(0);
    require('../mcp/tools');
    ({ allTools } = require('../mcp/registry'));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 180000);

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  let ip = 0;
  const call = async (path, { token, method = 'GET', body, form } = {}) => {
    ip += 1;
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'X-Forwarded-For': `10.8.${(ip >> 8) & 255}.${ip & 255}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form || (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
  };
  const mcp = async (name, args, who = 'member') => {
    const tool = allTools().find((t) => t.name === name);
    const user = who === 'admin' ? admin : world.users.alice;
    const roles = who === 'admin' ? ['user', 'admin', 'somm'] : ['user'];
    const res = await tool.handler(args, { user: { id: String(user._id), roles }, req: { user: { id: String(user._id), roles } } });
    const answer = JSON.parse(res.content[0].text);
    return { isError: !!res.isError, data: answer.data, error: answer.error };
  };

  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const raw = (id) => db.collection('winedefinitions').findOne({ _id: oid(id) });
  const byIdentity = ({ producer, name }) => db.collection('winedefinitions').find({ producer, name }).toArray();
  const lastSegment = (key) => { const bare = stripSweetnessKeySegment(key); return bare.slice(bare.lastIndexOf(':') + 1); };
  const tiersOf = async (w) => {
    const rows = await Classification.find({ _id: { $in: w.classifications || [] } }).select('name').lean();
    return rows.map((r) => r.name).sort();
  };

  /** The stored row is the Champagne form: the appellation, both keys, and exactly these tiers. */
  async function expectChampagne(id, tiers, { key } = {}) {
    const w = await raw(id);
    expect(w.appellation).toBe('Champagne');
    expect(lastSegment(w.normalizedKey)).toBe('champagne');
    expect(lastSegment(w.canonicalKey)).toBe('champagne');
    if (key) expect(w.normalizedKey).toBe(key);
    expect(await tiersOf(w)).toEqual([...tiers].sort());
    for (const t of tiers) expect(w.classification).toContain(t);
    return w;
  }

  /** A published wine stored as "Champagne": the row a cru-typed write must find. */
  async function stored({ producer, name }, { appellation = 'Champagne', classification, extra = {} } = {}) {
    const wine = new WineDefinition({
      name, producer, country: france._id, region: champagneRegion._id, appellation, type: 'sparkling',
      normalizedKey: generateWineKey(name, producer, appellation || ''), createdBy: admin._id, ...extra,
    });
    if (classification) await ops.assignClassification(wine, { classification, countryId: france._id });
    await wine.save();
    return wine;
  }

  const newWine = (id, over = {}) => ({ ...id, country: 'France', region: 'Champagne', type: 'sparkling', ...over });
  const home = () => String(world.cellars.home._id);
  const wineIdOf = (bottle) => String((bottle.wineDefinition && bottle.wineDefinition._id) || bottle.wineDefinition);

  describe.each([
    ['with the cru entries on the curated appellation list (before the script)', true],
    ['with the cru entries gone from the list (after the script)', false],
  ])('%s', (_label, cruEntries) => {
    beforeAll(async () => {
      await Appellation.deleteMany({ normalizedName: { $in: ['champagne grand cru', 'champagne premier cru'] } });
      if (cruEntries) {
        for (const name of ['Champagne Grand Cru', 'Champagne Premier Cru']) {
          await Appellation.create({ name, normalizedName: name.toLowerCase(), country: france._id, region: champagneRegion._id, createdBy: admin._id });
        }
      }
    });

    // ── The mint ────────────────────────────────────────────────────────────
    test('the add-bottle commit (POST /api/bottles newWine): a new wine, and the twin found', async () => {
      const a = fresh();
      const created = await call('/api/bottles', { token: tokens.member, method: 'POST', body: {
        cellar: home(), vintage: '2015',
        newWine: newWine(a, { appellation: 'Champagne Grand Cru', classification: 'Vieilles Vignes', confirmCreate: true }),
      } });
      expect(created.status).toBe(201);
      await expectChampagne(wineIdOf(created.body.bottle), ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });

      const b = fresh();
      const twin = await stored(b, { classification: 'Old Vines' });
      const found = await call('/api/bottles', { token: tokens.member, method: 'POST', body: {
        cellar: home(), vintage: '2016', newWine: newWine(b, { appellation: 'Champagne Premier Cru' }),
      } });
      expect(found.status).toBe(201);
      expect(wineIdOf(found.body.bottle)).toBe(String(twin._id));
      expect(await byIdentity(b)).toHaveLength(1);
      await expectChampagne(twin._id, ['Old Vines']);
    });

    test('the lookups (POST /api/wines/find-or-create, resolve_wine) land on the wine stored as Champagne', async () => {
      const b = fresh();
      const twin = await stored(b);
      const probe = await call('/api/wines/find-or-create', { token: tokens.member, method: 'POST', body: newWine(b, { appellation: 'Champagne 1er Cru' }) });
      expect(probe.status).toBe(200);
      expect(String(probe.body.wine._id)).toBe(String(twin._id));
      const resolved = await mcp('resolve_wine', { ...b, appellation: 'champagne grand cru' });
      expect(resolved.isError).toBe(false);
      expect(String(resolved.data.matched.wine_id)).toBe(String(twin._id));
    });

    test('the MCP add tools (add_bottle new_wine, bulk_add, admin_add_registry_wine)', async () => {
      const a = fresh();
      const added = await mcp('add_bottle', { cellar_id: home(), vintage: '2014', confirm_new_wine: true, new_wine: newWine(a, { appellation: 'Champagne 1er Cru', classification: 'Old Vines' }) });
      expect(added.isError).toBe(false);
      const [minted] = await byIdentity(a);
      await expectChampagne(minted._id, ['Old Vines', 'Premier Cru'], { key: generateWineKey(a.name, a.producer, 'Champagne') });

      const b = fresh();
      const twin = await stored(b);
      expect((await mcp('add_bottle', { cellar_id: home(), vintage: '2014', new_wine: newWine(b, { appellation: 'Champagne Grand Cru' }) })).isError).toBe(false);
      expect((await byIdentity(b)).map((w) => String(w._id))).toEqual([String(twin._id)]);

      // bulk_add: a preview, then the apply that mints one wine and finds the other.
      const e = fresh(); const f = fresh();
      const bulkTwin = await stored(f, { classification: 'Old Vines' });
      const preview = await mcp('bulk_add', { cellar_id: home(), items: [
        { vintage: '2013', confirm_new_wine: true, new_wine: newWine(e, { appellation: 'Champagne Grand Cru', classification: 'Reserve' }) },
        { vintage: '2013', new_wine: newWine(f, { appellation: 'Champagne Premier Cru' }) },
      ] });
      expect(preview.isError).toBe(false);
      expect(preview.data.applyable).toBe(true);
      const applied = await mcp('bulk_add', { mode: 'apply', preview_id: preview.data.preview_id });
      expect(applied.isError).toBe(false);
      expect(applied.data).toMatchObject({ wines_created: 1, failures: [] });
      const [bulkMinted] = await byIdentity(e);
      await expectChampagne(bulkMinted._id, ['Grand Cru', 'Reserve'], { key: generateWineKey(e.name, e.producer, 'Champagne') });
      expect((await byIdentity(f)).map((w) => String(w._id))).toEqual([String(bulkTwin._id)]);
      await expectChampagne(bulkTwin._id, ['Old Vines']);

      const c = fresh();
      const registry = await mcp('admin_add_registry_wine', newWine(c, { appellation: 'Champagne Grand Cru', confirm_create: true }), 'admin');
      expect(registry.isError).toBe(false);
      await expectChampagne(registry.data.wine_id, ['Grand Cru']);
      const again = await mcp('admin_add_registry_wine', newWine(c, { appellation: 'Champagne' }), 'admin');
      expect(again.data.created).toBe(false);
      expect(String(again.data.wine_id)).toBe(String(registry.data.wine_id));
    });

    test('the import confirm path (POST /api/bottles/import/confirm)', async () => {
      const a = fresh(); const b = fresh();
      const twin = await stored(b, { classification: 'Old Vines' });
      const res = await call('/api/bottles/import/confirm', { token: tokens.member, method: 'POST', body: {
        cellarId: home(),
        items: [
          { vintage: '2012', aiWine: newWine(a, { appellation: 'Champagne Premier Cru', classification: 'Vieilles Vignes', grapes: [] }) },
          { vintage: '2013', aiWine: newWine(b, { appellation: 'Champagne Grand Cru', grapes: [] }) },
        ],
      } });
      expect(res.status).toBe(200);
      const [minted] = await byIdentity(a);
      await expectChampagne(minted._id, ['Old Vines', 'Premier Cru'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
      expect((await byIdentity(b)).map((w) => String(w._id))).toEqual([String(twin._id)]);
      await expectChampagne(twin._id, ['Old Vines']);
    });

    test('the cellar-file import, and the demo clone that may only match', async () => {
      const { importCellar } = require('../services/cellarImport');
      const a = fresh(); const b = fresh(); const unknown = fresh();
      const twin = await stored(b);
      const bottle = (id, appellation) => ({ wineName: id.name, producer: id.producer, vintage: '2011', country: 'France', region: 'Champagne', appellation, type: 'sparkling', grapes: [] });
      const opts = { mode: 'create', getFileBuffer: () => null, defaultCurrency: 'USD' };
      const imported = await importCellar(world.users.alice._id, { cellarName: 'File', description: '', racks: [], layout: null, bottles: [bottle(a, 'Champagne Grand Cru'), bottle(b, 'Champagne 1er Cru')] }, { ...opts, targetName: `File ${cruEntries}` });
      expect(imported.bottlesCreated).toBe(2);
      const [minted] = await byIdentity(a);
      await expectChampagne(minted._id, ['Grand Cru'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
      expect((await byIdentity(b)).map((w) => String(w._id))).toEqual([String(twin._id)]);

      const before = await db.collection('winedefinitions').countDocuments({});
      const demo = await importCellar(world.users.carol._id, { cellarName: 'Demo', description: '', racks: [], layout: null, bottles: [bottle(b, 'Champagne Grand Cru'), bottle(unknown, 'Champagne Grand Cru')] }, { ...opts, targetName: `Demo ${cruEntries}`, demoMode: true });
      expect(demo.bottlesCreated).toBe(1);
      expect(demo.winesSkipped).toBe(1);
      expect(await db.collection('winedefinitions').countDocuments({})).toBe(before);
    });

    // ── The admin wine routes ───────────────────────────────────────────────
    test('admin create (POST /api/admin/wines): stored as Champagne, and the twin refused', async () => {
      const a = fresh();
      const created = await call('/api/admin/wines', { token: tokens.admin, method: 'POST', body: {
        ...a, country: String(france._id), region: String(champagneRegion._id), type: 'sparkling',
        appellation: 'Champagne Grand Cru', classification: 'Old Vines', confirmCreate: true,
      } });
      expect(created.status).toBe(201);
      expect(created.body.wine).toMatchObject({ appellation: 'Champagne', classification: 'Grand Cru, Old Vines' });
      await expectChampagne(created.body.wine._id, ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });

      const b = fresh();
      const twin = await stored(b);
      const body = { ...b, country: String(france._id), type: 'sparkling', appellation: 'Champagne Premier Cru' };
      const asked = await call('/api/admin/wines', { token: tokens.admin, method: 'POST', body });
      expect(asked.status).toBe(409);
      expect(asked.body.candidates.map((c) => String(c._id))).toContain(String(twin._id));
      const forced = await call('/api/admin/wines', { token: tokens.admin, method: 'POST', body: { ...body, confirmCreate: true } });
      expect(forced.status).toBe(400);
      expect(await byIdentity(b)).toHaveLength(1);
    });

    test('admin edit (PUT /api/admin/wines/:id): the cru joins the tiers, a twin is refused, Cognac and a village stay as typed', async () => {
      const a = fresh();
      const wine = await stored(a, { appellation: 'Coteaux Champenois', classification: 'Old Vines' });
      const put = await call(`/api/admin/wines/${wine._id}`, { token: tokens.admin, method: 'PUT', body: { appellation: 'Champagne Grand Cru' } });
      expect(put.status).toBe(200);
      expect(put.body.wine.appellation).toBe('Champagne');
      await expectChampagne(wine._id, ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
      // The form re-sends every field: a typed classification and the cru both land.
      const resent = await call(`/api/admin/wines/${wine._id}`, { token: tokens.admin, method: 'PUT', body: { ...a, appellation: 'Champagne 1er Cru', classification: 'Reserve' } });
      expect(resent.status).toBe(200);
      await expectChampagne(wine._id, ['Premier Cru', 'Reserve']);

      const b = fresh();
      await stored(b);
      const other = await stored(b, { appellation: 'Coteaux Champenois' });
      const clash = await call(`/api/admin/wines/${other._id}`, { token: tokens.admin, method: 'PUT', body: { appellation: 'Champagne Grand Cru' } });
      expect(clash.status).toBe(400);
      expect((await raw(other._id)).appellation).toBe('Coteaux Champenois');

      const c = fresh();
      const cognac = await stored(c, { appellation: 'Cognac' });
      for (const [appellation, segment] of [['Grande Champagne', 'grande champagne'], ['Fine Champagne', 'fine champagne'], ['Champagne Grand Cru (Bouzy)', 'champagne grand cru bouzy']]) {
        const res = await call(`/api/admin/wines/${cognac._id}`, { token: tokens.admin, method: 'PUT', body: { appellation } });
        expect(res.status).toBe(200);
        const w = await raw(cognac._id);
        expect(w.appellation).toBe(appellation);
        expect(lastSegment(w.normalizedKey)).toBe(segment);
        expect(lastSegment(w.canonicalKey)).toBe(segment);
        expect(w.classification == null).toBe(true);
        expect(w.classifications || []).toEqual([]);
      }
    });

    test('a wine report applied by an admin (PUT /api/admin/wine-reports/:id/resolve)', async () => {
      const a = fresh();
      const wine = await stored(a, { appellation: 'Coteaux Champenois', classification: 'Old Vines' });
      const report = await db.collection('winereports').insertOne({
        user: world.users.alice._id, wineDefinition: wine._id, reason: 'wrong_info', status: 'pending',
        suggestedField: 'appellation', suggestedValue: 'Champagne Grand Cru', createdAt: new Date(), updatedAt: new Date(),
      });
      const res = await call(`/api/admin/wine-reports/${report.insertedId}/resolve`, { token: tokens.admin, method: 'PUT', body: { applySuggestion: true, response: 'Applied, thank you.' } });
      expect(res.status).toBe(200);
      expect(res.body.applied).toMatchObject({ field: 'appellation', to: 'Champagne' });
      await expectChampagne(wine._id, ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
    });

    // ── Wine requests ───────────────────────────────────────────────────────
    test('a wine request approved as a new wine (PUT /api/admin/wine-requests/:id/resolve)', async () => {
      const request = async (wineName) => (await db.collection('winerequests').insertOne({
        user: world.users.alice._id, requestType: 'new_wine', wineName, status: 'pending', createdAt: new Date(), updatedAt: new Date(),
      })).insertedId;
      const a = fresh();
      const approved = await call(`/api/admin/wine-requests/${await request(a.name)}/resolve`, { token: tokens.admin, method: 'PUT', body: {
        createNew: true, confirmCreate: true, classification: 'Old Vines',
        wineData: { ...a, country: String(france._id), region: String(champagneRegion._id), type: 'sparkling', appellation: 'Champagne Premier Cru' },
      } });
      expect(approved.status).toBe(200);
      const [minted] = await byIdentity(a);
      await expectChampagne(minted._id, ['Old Vines', 'Premier Cru'], { key: generateWineKey(a.name, a.producer, 'Champagne') });

      const b = fresh();
      const twin = await stored(b);
      const body = { createNew: true, wineData: { ...b, country: String(france._id), type: 'sparkling', appellation: 'Champagne Grand Cru' } };
      const id = await request(b.name);
      const asked = await call(`/api/admin/wine-requests/${id}/resolve`, { token: tokens.admin, method: 'PUT', body });
      expect(asked.status).toBe(409);
      expect(asked.body.candidates.map((c) => String(c._id))).toContain(String(twin._id));
      // "Create anyway" meets the unique key and links the request to the twin.
      const linked = await call(`/api/admin/wine-requests/${id}/resolve`, { token: tokens.admin, method: 'PUT', body: { ...body, confirmCreate: true } });
      expect(linked.status).toBe(200);
      expect(await byIdentity(b)).toHaveLength(1);
      expect(String((await db.collection('winerequests').findOne({ _id: id })).linkedWineDefinition)).toBe(String(twin._id));
    });

    // ── Correction proposals ────────────────────────────────────────────────
    test('a member\'s correction, filed and approved; a twin is refused at approval', async () => {
      const file = (wineId) => call('/api/wine-proposals', { token: filers.shift(), method: 'POST', body: {
        wineId: String(wineId), fields: { appellation: 'Champagne Grand Cru' }, reason: 'The label states the village is a grand cru.',
      } });
      const a = fresh();
      const wine = await stored(a, { appellation: 'Coteaux Champenois', classification: 'Old Vines' });
      const filed = await file(wine._id);
      expect([200, 201]).toContain(filed.status);
      const approved = await call(`/api/admin/wine-proposals/${filed.body.proposal._id}/approve`, { token: tokens.admin, method: 'POST', body: {} });
      expect(approved.status).toBe(200);
      await expectChampagne(wine._id, ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });

      const b = fresh();
      await stored(b);
      const other = await stored(b, { appellation: 'Coteaux Champenois' });
      const second = await file(other._id);
      const refused = await call(`/api/admin/wine-proposals/${second.body.proposal._id}/approve`, { token: tokens.admin, method: 'POST', body: {} });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('identical_wine');
      expect((await raw(other._id)).appellation).toBe('Coteaux Champenois');
    });

    test('a sommelier\'s correction that applies on filing (propose_wine_correction)', async () => {
      const a = fresh();
      const wine = await stored(a, { appellation: null });
      const res = await mcp('propose_wine_correction', {
        wine_id: String(wine._id), kind: 'field_correction', proposed_fields: { appellation: 'Champagne Premier Cru' },
        reason: 'The back label names a premier cru village.',
      }, 'admin');
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('approved');
      await expectChampagne(wine._id, ['Premier Cru'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
    });

    // ── Pending wines ───────────────────────────────────────────────────────
    test('a pending wine, minted without a producer and completed by a curator (REST and fix_pending_wine)', async () => {
      const pending = async (id, over = {}) => {
        const res = await call('/api/bottles', { token: tokens.member, method: 'POST', body: {
          cellar: home(), vintage: '2010', newWine: { name: id.name, country: 'France', region: 'Champagne', type: 'sparkling', confirmCreate: true, ...over },
        } });
        expect(res.status).toBe(201);
        return wineIdOf(res.body.bottle);
      };
      const a = fresh();
      const minted = await pending(a, { appellation: 'Champagne Grand Cru' });
      await expectChampagne(minted, ['Grand Cru'], { key: pendingWineKey(a.name, world.users.alice._id, 'Champagne') });

      const b = fresh();
      const queued = await pending(b, { classification: 'Old Vines' });
      const fixed = await call(`/api/somm/pending-wines/${queued}`, { token: tokens.admin, method: 'PATCH', body: { producer: b.producer, appellation: 'Champagne Premier Cru' } });
      expect(fixed.status).toBe(200);
      expect(fixed.body).toMatchObject({ promoted: true, wine: { appellation: 'Champagne' } });
      await expectChampagne(queued, ['Old Vines', 'Premier Cru'], { key: generateWineKey(b.name, b.producer, 'Champagne') });

      const c = fresh();
      const stays = await pending(c);
      const tool = await mcp('fix_pending_wine', { wine_id: stays, appellation: 'Champagne 1er Cru' }, 'admin');
      expect(tool.isError).toBe(false);
      await expectChampagne(stays, ['Premier Cru'], { key: pendingWineKey(c.name, world.users.alice._id, 'Champagne') });

      const d = fresh();
      await stored(d);
      const twinToBe = await pending(d);
      const clash = await call(`/api/somm/pending-wines/${twinToBe}`, { token: tokens.admin, method: 'PATCH', body: { producer: d.producer, appellation: 'Champagne Grand Cru' } });
      expect(clash.status).toBe(409);
      expect((await raw(twinToBe)).pendingIdentity).toBe(true);
    });

    // ── Drafts ──────────────────────────────────────────────────────────────
    test('a private draft: minted, edited (REST and update_wine_draft) and published', async () => {
      const draft = async (id, over = {}) => {
        const res = await call('/api/bottles', { token: tokens.member, method: 'POST', body: {
          cellar: home(), vintage: '2009', newWine: newWine(id, { draft: true, confirmCreate: true, ...over }),
        } });
        expect(res.status).toBe(201);
        return wineIdOf(res.body.bottle);
      };
      const alice = world.users.alice._id;
      const a = fresh();
      const id = await draft(a, { appellation: 'Champagne Grand Cru' });
      await expectChampagne(id, ['Grand Cru'], { key: draftWineKey(a.name, a.producer, alice, 'Champagne') });

      const b = fresh();
      const edited = await draft(b, { appellation: 'Coteaux Champenois', classification: 'Old Vines' });
      const patch = await call(`/api/wine-drafts/${edited}`, { token: tokens.member, method: 'PATCH', body: { appellation: 'Champagne Premier Cru' } });
      expect(patch.status).toBe(200);
      await expectChampagne(edited, ['Old Vines', 'Premier Cru'], { key: draftWineKey(b.name, b.producer, alice, 'Champagne') });
      const published = await call(`/api/wine-drafts/${edited}/publish`, { token: tokens.member, method: 'POST', body: { confirmCreate: true } });
      expect(published.status).toBe(200);
      await expectChampagne(edited, ['Old Vines', 'Premier Cru'], { key: generateWineKey(b.name, b.producer, 'Champagne') });

      const c = fresh();
      const viaTool = await draft(c, { appellation: 'Coteaux Champenois' });
      const tool = await mcp('update_wine_draft', { wine_id: viaTool, appellation: 'champagne grand cru' });
      expect(tool.isError).toBe(false);
      await expectChampagne(viaTool, ['Grand Cru'], { key: draftWineKey(c.name, c.producer, alice, 'Champagne') });

      // A draft of a wine the registry holds as Champagne does not publish as its twin.
      const d = fresh();
      const dup = await draft(d, { appellation: 'Coteaux Champenois' });
      const twin = await stored(d);
      expect((await call(`/api/wine-drafts/${dup}`, { token: tokens.member, method: 'PATCH', body: { appellation: 'Champagne Grand Cru' } })).status).toBe(200);
      const refused = await call(`/api/wine-drafts/${dup}/publish`, { token: tokens.member, method: 'POST', body: { confirmCreate: true } });
      expect(refused.status).not.toBe(200);
      expect((await raw(dup)).draft).toBe(true);
      expect((await db.collection('winedefinitions').find({ ...d, draft: { $ne: true } }).toArray()).map((w) => String(w._id))).toEqual([String(twin._id)]);
    });

    // ── The registry file import: a bulk write the model hook never sees ────
    test('the admin registry import (POST /api/admin/import/wines)', async () => {
      const a = fresh(); const b = fresh(); const c = fresh();
      const twin = await stored(b);
      const csv = [
        'Producer,Wine,Country,Region,Appellation,WineType,Classification,LWIN7',
        `${a.producer},${a.name},France,Champagne,Champagne Grand Cru,sparkling,Vieilles Vignes,`,
        `${b.producer},${b.name},France,Champagne,Champagne Premier Cru,sparkling,,`,
        `${c.producer},${c.name},France,Cognac,Grande Champagne,white,,`,
      ].join('\n');
      const form = new FormData();
      form.append('file', new Blob([csv], { type: 'text/csv' }), 'wines.csv');
      const res = await call('/api/admin/import/wines', { token: tokens.admin, method: 'POST', form });
      expect(res.status).toBe(200);
      expect(res.body.stats).toMatchObject({ total: 3, created: 2 });

      const [minted] = await byIdentity(a);
      await expectChampagne(minted._id, ['Grand Cru', 'Old Vines'], { key: generateWineKey(a.name, a.producer, 'Champagne') });
      expect(minted.canonicalKey).toBe(computeCanonicalKey(a.name, a.producer, 'Champagne'));
      // The twin is matched, and its empty classification is filled.
      expect((await byIdentity(b)).map((w) => String(w._id))).toEqual([String(twin._id)]);
      await expectChampagne(twin._id, ['Premier Cru']);
      // Cognac is another appellation.
      const [cognac] = await byIdentity(c);
      expect(cognac.appellation).toBe('Grande Champagne');
      expect(lastSegment(cognac.normalizedKey)).toBe('grande champagne');
      expect(cognac.classification == null).toBe(true);
      // The import mints curated appellations it meets: never a cru entry.
      const cruEntryCount = await Appellation.countDocuments({ normalizedName: { $in: ['champagne grand cru', 'champagne premier cru'] } });
      expect(cruEntryCount).toBe(cruEntries ? 2 : 0);
    });

    // ── The traps, through the mint ─────────────────────────────────────────
    test('Cognac and a named village are minted as typed', async () => {
      for (const [appellation, segment] of [['Grande Champagne', 'grande champagne'], ['Petite Champagne', 'petite champagne'], ['Fine Champagne', 'fine champagne'], ['Champagne Grand Cru (Bouzy)', 'champagne grand cru bouzy']]) {
        const a = fresh();
        const res = await call('/api/bottles', { token: tokens.member, method: 'POST', body: {
          cellar: home(), vintage: '2008', newWine: newWine(a, { region: 'Cognac', type: 'white', appellation, confirmCreate: true }),
        } });
        expect(res.status).toBe(201);
        const w = await raw(wineIdOf(res.body.bottle));
        expect(w.appellation).toBe(appellation);
        expect(lastSegment(w.normalizedKey)).toBe(segment);
        expect(lastSegment(w.canonicalKey)).toBe(segment);
        expect(w.classification == null).toBe(true);
        expect(w.classifications || []).toEqual([]);
      }
    });
  });
});
