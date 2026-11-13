/**
 * The cellar search finds a bottle by its extra facts — on REAL documents in a
 * REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * A bottle's facts come from two readers with rules of their own: the
 * published registry values of its wine, resolved for its vintage the way the
 * wine record resolves them (registryDataOps), and the personal data entries
 * its bottle page shows (personalData.listForBottles: bottle-level entries,
 * and wine-level entries of the cellar's members only, vintage-scoped where
 * the entry is). The unit suite (bottleSearch.test.js) mocks both readers;
 * only real rows, real key states and the real version bumps show that the
 * search finds exactly what the bottle page shows, and nothing more.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_searchfacts`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'search-facts-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'search-facts-meili-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';
process.env.FRONTEND_URL = 'http://127.0.0.1:9';

// The Meilisearch client is ESM-only (Jest cannot load it); the MCP tool
// modules load it, and nothing here searches through it.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mongoose = require('mongoose');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_searchfacts'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/bottleSearch.facts.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('the cellar search reads a bottle\'s extra facts (real MongoDB)', () => {
  let User; let Country; let WineDefinition; let Cellar; let Bottle;
  let RegistryDataKey; let RegistryDataValue; let PersonalDataKey;
  let registryDataOps; let personalData; let bottleSearch; let getDataVersion; let allTools;
  let owner; let member; let stranger; let admin;
  let estate; let plain; let home; let away;
  let b19; let b20; let bNV; let bNone; let bPlain; let bAway;
  const keys = {};

  const PASSWORD = 'Search-Facts-Passw0rd!';

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();

    User = require('../models/User');
    Country = require('../models/Country');
    WineDefinition = require('../models/WineDefinition');
    Cellar = require('../models/Cellar');
    Bottle = require('../models/Bottle');
    RegistryDataKey = require('../models/RegistryDataKey');
    RegistryDataValue = require('../models/RegistryDataValue');
    PersonalDataKey = require('../models/PersonalDataKey');
    registryDataOps = require('./registryDataOps');
    personalData = require('./personalData');
    bottleSearch = require('./bottleSearch');
    ({ getDataVersion } = require('./dataVersion'));
    require('../mcp/tools');
    ({ allTools } = require('../mcp/registry'));
    await Promise.all([RegistryDataValue.init(), RegistryDataKey.init(), PersonalDataKey.init()]);

    owner = await User.create({ username: 'owner', email: 'owner@facts.test', password: PASSWORD });
    member = await User.create({ username: 'member', email: 'member@facts.test', password: PASSWORD });
    stranger = await User.create({ username: 'stranger', email: 'stranger@facts.test', password: PASSWORD });
    admin = await User.create({ username: 'curator', email: 'curator@facts.test', password: PASSWORD, roles: ['user', 'admin'] });

    const france = await Country.create({ name: 'France', normalizedName: 'france', createdBy: owner._id });
    estate = await WineDefinition.create({
      name: 'Clos Exemple', producer: 'Domaine Exemple', type: 'red', country: france._id,
      normalizedKey: 'clos exemple|domaine exemple|', createdBy: owner._id,
    });
    plain = await WineDefinition.create({
      name: 'Cuvée Simple', producer: 'Maison Simple', type: 'white', country: france._id,
      normalizedKey: 'cuvee simple|maison simple|', createdBy: owner._id,
    });

    home = await Cellar.create({ name: 'Home', user: owner._id, members: [{ user: member._id, role: 'editor' }] });
    away = await Cellar.create({ name: 'Elsewhere', user: stranger._id });

    const mine = { user: owner._id, cellar: home._id };
    b19 = await Bottle.create({ ...mine, wineDefinition: estate._id, vintage: '2019' });
    b20 = await Bottle.create({ ...mine, wineDefinition: estate._id, vintage: '2020' });
    bNV = await Bottle.create({ ...mine, wineDefinition: estate._id, vintage: 'NV' });
    // A bottle with no vintage at all (rows older than the field's default).
    const { insertedId } = await Bottle.collection.insertOne({ ...mine, wineDefinition: estate._id, createdAt: new Date() });
    bNone = await Bottle.findById(insertedId).lean();
    bPlain = await Bottle.create({ ...mine, wineDefinition: plain._id, vintage: '2019' });
    bAway = await Bottle.create({ user: stranger._id, cellar: away._id, wineDefinition: estate._id, vintage: '2019' });

    // The public vocabulary: every type, and a key in each state.
    const key = (name, type, extra = {}) => RegistryDataKey.create({
      name, type, status: 'accepted', rationale: 'A durable property of the wine.', ...extra,
    });
    keys.owner = await key('Estate owner', 'text');
    keys.closure = await key('Closure', 'enum', { enumOptions: ['Natural cork', 'Screw cap'] });
    keys.abv = await key('ABV', 'decimal', { unit: '%' });
    keys.vines = await key('Vine age', 'integer');
    keys.organic = await key('Certified organic', 'boolean');
    keys.harvest = await key('Harvest date', 'date');
    keys.story = await key('Vintage story', 'text');
    keys.note = await key('Harvest note', 'text');
    keys.proposed = await key('Cooperage', 'text', { status: 'proposed', proposedBy: member._id });
    keys.removed = await key('Soil', 'text', { status: 'rejected' });
    keys.gone = await key('Former field', 'text');

    const value = (wine, k, v, extra = {}) => RegistryDataValue.create({
      wineDefinition: wine._id, key: k._id, value: v, status: 'published', suggestedBy: admin._id, ...extra,
    });
    await value(estate, keys.owner, 'Vignobles Henri-Paul Montaubrac');
    await value(estate, keys.closure, 'Screw cap');
    await value(estate, keys.abv, 13.5);
    await value(estate, keys.vines, 45);
    await value(estate, keys.organic, true);
    await value(estate, keys.harvest, '1987-09-21');
    // The default, and a 2019 value that wins over it on the 2019 bottle.
    await value(estate, keys.story, 'Steady ripening');
    await value(estate, keys.story, 'Hailstorm summer', { vintage: '2019' });
    // A value for 2019 only.
    await value(estate, keys.note, 'Frostbitten', { vintage: '2019' });
    // Not published, or of a key that is not in the vocabulary.
    await value(plain, keys.owner, 'Bellevue Holdings', { status: 'suggested' });
    await value(plain, keys.closure, 'Natural cork', { status: 'rejected' });
    await value(estate, keys.proposed, 'Tonnellerie Exemple');
    await value(estate, keys.removed, 'Limestone');
    await value(estate, keys.gone, 'Ghostvalue');
    await RegistryDataKey.deleteOne({ _id: keys.gone._id });
    // A published empty string, written past the entry rules.
    await RegistryDataValue.collection.insertOne({
      wineDefinition: plain._id, key: keys.owner._id, vintage: null, value: '', status: 'published', suggestedBy: admin._id,
    });
    registryDataOps.invalidateVocabCache();

    // Personal data, written the way the app writes it.
    const entry = async (author, bottle, body) => {
      const r = await personalData.createEntry(author._id, bottle, body);
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      return r;
    };
    await entry(owner, b20, { level: 'bottle', newKey: { name: 'Bought from', type: 'text' }, value: 'Riverside Merchants' });
    await entry(owner, b20, { level: 'bottle', newKey: { name: 'Storage', type: 'enum', enumOptions: ['Cellar', 'Fridge'] }, value: 'Fridge' });
    await entry(member, b19, { level: 'wine', newKey: { name: 'Tasting group', type: 'text' }, value: 'Thursday Circle' });
    await entry(owner, b19, { level: 'wine', vintageScoped: true, newKey: { name: 'Occasion', type: 'text' }, value: 'Magnum party' });
    await entry(owner, b19, { level: 'wine', newKey: { name: 'Cork length', type: 'decimal', unit: 'mm' }, value: 54 });
    // Someone who is not a member of Home, on their own bottle of the same wine.
    await entry(stranger, bAway, { level: 'wine', newKey: { name: 'Source', type: 'text' }, value: 'Harbourside Imports' });
    // An entry whose key is gone.
    const orphan = await entry(owner, bPlain, { level: 'bottle', newKey: { name: 'Temporary', type: 'text' }, value: 'Orphaned' });
    await PersonalDataKey.collection.deleteOne({ _id: orphan.entry.key._id });
  }, 180000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }, 60000);

  beforeEach(() => bottleSearch._internal.forgetAllDocs());

  const id = (b) => String(b._id);
  const found = async (query, opts = {}) => {
    const res = await bottleSearch.searchBottles(query, { cellarId: id(home), limit: 100, ...opts });
    return [...res.ids].sort();
  };
  const ids = (...bottles) => bottles.map(id).sort();
  const ESTATE_HERE = () => ids(b19, b20, bNV, bNone);
  // The search's version as routes/cellars passes it (scopeVersion): the
  // owners' data versions.
  const versionOf = (...owners) => owners.map((o) => String(o._id)).sort()
    .map((o) => `${o}:${getDataVersion(o)}`).join(',');

  describe('public registry values', () => {
    test('a published text value finds every bottle of its wine; the name and producer hold no such word', async () => {
      expect(await found('montaubrac')).toEqual(ESTATE_HERE());
      expect(await found('henri paul montaubrac')).toEqual(ESTATE_HERE());
    });

    test('an enum value is found; a decimal, integer, boolean or date value is not', async () => {
      expect(await found('screw cap')).toEqual(ESTATE_HERE());
      expect(await found('13')).toEqual([]);
      expect(await found('13.5')).toEqual([]);
      expect(await found('45')).toEqual([]);
      expect(await found('true')).toEqual([]);
      expect(await found('1987')).toEqual([]);
    });

    test('vintage: a 2019 value is found on the 2019 bottle only; the default on every other; the 2019 value wins where both exist', async () => {
      expect(await found('frostbitten')).toEqual(ids(b19));
      expect(await found('hailstorm')).toEqual(ids(b19));
      expect(await found('steady ripening')).toEqual(ids(b20, bNV, bNone));
    });

    test('suggested and rejected values, and values of a proposed, removed or deleted key, are not found', async () => {
      expect(await found('screw cap')).toEqual(ESTATE_HERE()); // a published value of an accepted key is
      expect(await found('bellevue')).toEqual([]);
      expect(await found('natural cork')).toEqual([]);
      expect(await found('tonnellerie')).toEqual([]);
      expect(await found('limestone')).toEqual([]);
      expect(await found('ghostvalue')).toEqual([]);
    });

    test('the reader resolves one value per key for each bottle, in key name order', async () => {
      const out = await registryDataOps.publishedValuesForBottles(
        [b19, b20, bNone, bPlain, { _id: 'no-wine', wineDefinition: null }].map((b) => ({ _id: b._id, wineDefinition: b.wineDefinition, vintage: b.vintage })),
        { types: ['text', 'enum'] },
      );
      expect(out.get(id(b19))).toEqual([
        { key: 'Closure', type: 'enum', value: 'Screw cap' },
        { key: 'Estate owner', type: 'text', value: 'Vignobles Henri-Paul Montaubrac' },
        { key: 'Harvest note', type: 'text', value: 'Frostbitten' },
        { key: 'Vintage story', type: 'text', value: 'Hailstorm summer' },
      ]);
      expect(out.get(id(b20)).map((v) => v.value)).toEqual(['Screw cap', 'Vignobles Henri-Paul Montaubrac', 'Steady ripening']);
      expect(out.get(id(bNone)).map((v) => v.value)).toEqual(['Screw cap', 'Vignobles Henri-Paul Montaubrac', 'Steady ripening']);
      // The wine with only a suggested, a rejected and an empty value.
      expect(out.get(id(bPlain))).toEqual([{ key: 'Estate owner', type: 'text', value: '' }]);
      expect(out.get('no-wine')).toEqual([]);
      // Without types, every accepted key's value.
      const all = await registryDataOps.publishedValuesForBottles([{ _id: b20._id, wineDefinition: estate._id, vintage: '2020' }]);
      expect(all.get(id(b20)).map((v) => v.key)).toEqual(['ABV', 'Certified organic', 'Closure', 'Estate owner', 'Harvest date', 'Vine age', 'Vintage story']);
    });
  });

  describe('personal data entries — exactly where the bottle page shows them', () => {
    test('a bottle-level entry is found on its bottle; a list value too', async () => {
      expect(await found('riverside')).toEqual(ids(b20));
      expect(await found('fridge')).toEqual(ids(b20));
    });

    test('a wine-level entry by a member of the cellar is found on every bottle of the wine there', async () => {
      expect(await found('thursday circle')).toEqual(ESTATE_HERE());
    });

    test('a wine-level entry by someone who is not a member is not found here — only in their own cellar', async () => {
      expect(await found('harbourside')).toEqual([]);
      expect(await found('harbourside', { cellarId: id(away) })).toEqual(ids(bAway));
      // The member's entry is not shown in a cellar they are not in.
      expect(await found('thursday', { cellarId: id(away) })).toEqual([]);
    });

    test('a vintage-scoped entry is found on bottles of its vintage only', async () => {
      expect(await found('magnum party')).toEqual(ids(b19));
    });

    test('a number entry and an entry whose key is gone are not found, and break nothing', async () => {
      expect(await found('riverside')).toEqual(ids(b20)); // a text entry is
      expect(await found('54')).toEqual([]);
      expect(await found('orphaned')).toEqual([]);
    });

    test('the multi-cellar view reads each cellar\'s own people', async () => {
      const res = await bottleSearch.searchBottles('harbourside thursday', { cellarIds: [id(home), id(away)], limit: 100 });
      // Only the first word must match: each bottle by its own cellar's entries.
      expect([...res.ids].sort()).toEqual(ids(bAway));
      expect([...(await bottleSearch.searchBottles('thursday', { cellarIds: [id(home), id(away)], limit: 100 })).ids].sort()).toEqual(ESTATE_HERE());
    });
  });

  test('key names are never searched', async () => {
    expect(await found('montaubrac')).toEqual(ESTATE_HERE()); // the value is
    for (const name of ['estate owner', 'vintage story', 'closure', 'bought from', 'tasting group', 'occasion']) {
      expect(await found(name)).toEqual([]);
    }
  });

  test('a facts match ranks below the wine\'s own fields and above the notes', async () => {
    const named = await WineDefinition.create({
      name: 'Montaubrac Réserve', producer: 'Maison Autre', type: 'red', country: estate.country,
      normalizedKey: 'montaubrac reserve|maison autre|', createdBy: owner._id,
    });
    const byName = await Bottle.create({ user: owner._id, cellar: home._id, wineDefinition: named._id, vintage: '2018' });
    const byNotes = await Bottle.create({ user: owner._id, cellar: home._id, wineDefinition: plain._id, vintage: '2018', notes: 'Montaubrac told us to wait' });
    try {
      const res = await bottleSearch.searchBottles('montaubrac', { cellarId: id(home), limit: 100, sort: '-createdAt' });
      expect(res.ids[0]).toBe(id(byName));
      expect(res.ids[res.ids.length - 1]).toBe(id(byNotes));
      expect([...res.ids.slice(1, -1)].sort()).toEqual(ESTATE_HERE());
      // One typo still finds the fact.
      expect([...(await found('montuabrac'))]).toEqual(ids(b19, b20, bNV, bNone, byName, byNotes));
    } finally {
      await Bottle.deleteMany({ _id: { $in: [byName._id, byNotes._id] } });
      await WineDefinition.deleteOne({ _id: named._id });
    }
  });

  test('the MCP tool search_bottles finds a bottle by a fact', async () => {
    const tool = allTools().find((t) => t.name === 'search_bottles');
    const res = await tool.handler({ query: 'montaubrac', cellar_id: id(home), status: 'active', limit: 50, offset: 0 }, { user: { id: String(owner._id) }, scopes: ['read'] });
    const body = JSON.parse(res.content[0].text);
    expect(body.data.map((b) => String(b.bottle_id)).sort()).toEqual(ESTATE_HERE());
  });

  describe('freshness', () => {
    test('a new personal entry is searchable on the next request: the write moves the version the search is kept under', async () => {
      const before = versionOf(owner);
      expect(await found('nightingale', { version: before })).toEqual([]);
      // A member's bottle-level entry in the owner's cellar.
      const r = await personalData.createEntry(member._id, b19, { level: 'bottle', newKey: { name: 'Shelf mark', type: 'text' }, value: 'Nightingale' });
      expect(r.ok).toBe(true);
      const after = versionOf(owner);
      expect(after).not.toBe(before);
      expect(await found('nightingale', { version: after })).toEqual(ids(b19));
      // A member's wine-level entry moves the owner's version too.
      expect(await found('lantern', { version: after })).toEqual([]);
      const w = await personalData.createEntry(member._id, b20, { level: 'wine', newKey: { name: 'Club', type: 'text' }, value: 'Lantern Society' });
      expect(w.ok).toBe(true);
      expect(versionOf(owner)).not.toBe(after);
      expect(await found('lantern', { version: versionOf(owner) })).toEqual(ESTATE_HERE());
    });

    test('a registry value published by a curator moves no member\'s version: kept documents find it once they expire', async () => {
      const version = versionOf(owner);
      expect(await found('marlowe', { version })).toEqual([]);
      const row = await RegistryDataValue.create({
        wineDefinition: plain._id, key: keys.story._id, value: 'Marlowe vintage', status: 'suggested', suggestedBy: member._id,
      });
      const decided = await registryDataOps.decideValue(admin._id, row._id, 'publish', null, { notify: false });
      expect(decided.ok).toBe(true);
      expect(versionOf(owner)).toBe(version);
      // Kept under the same version: not yet (within DOCS_TTL_MS)…
      expect(await found('marlowe', { version })).toEqual([]);
      // …read at once without a version, and by kept documents once they go.
      expect(await found('marlowe')).toEqual(ids(bPlain));
      bottleSearch._internal.forgetAllDocs();
      expect(await found('marlowe', { version })).toEqual(ids(bPlain));
    });
  });

  test('a wine still pending identity gives no registry values to the search, for anyone', async () => {
    const pendingWine = await WineDefinition.create({
      name: 'Unidentified red', producer: 'Maison Inconnue', type: 'red', country: estate.country,
      normalizedKey: 'unidentified red|maison inconnue|', createdBy: owner._id,
    });
    await WineDefinition.collection.updateOne({ _id: pendingWine._id }, { $set: { pendingIdentity: true } });
    const bp = await Bottle.create({ user: owner._id, cellar: home._id, wineDefinition: pendingWine._id, vintage: '2021' });
    await RegistryDataValue.create({
      wineDefinition: pendingWine._id, key: keys.owner._id, value: 'Hiddenfield Estates', status: 'published', suggestedBy: admin._id,
    });
    expect(await found('hiddenfield')).toEqual([]);
    await WineDefinition.collection.updateOne({ _id: pendingWine._id }, { $set: { pendingIdentity: false } });
    expect(await found('hiddenfield')).toEqual(ids(bp));
  });

  test('a bottle stored without a vintage reads NV-scoped wine-level entries, as its page does', async () => {
    const r = await personalData.createEntry(owner._id, bNV, {
      level: 'wine', vintageScoped: true, newKey: { name: 'Bottling mark', type: 'text' }, value: 'Nonvintage cuvee',
    });
    expect(r.ok).toBe(true);
    expect(await found('nonvintage')).toEqual(ids(bNV, bNone));
  });

  test('the registry values are read through the per-slot index, and without it while it does not exist yet', async () => {
    const INDEX = { wineDefinition: 1, key: 1, vintage: 1, status: 1 };
    const plan = await RegistryDataValue.find({ wineDefinition: { $in: [estate._id] }, status: 'published' }).hint(INDEX).explain();
    expect(JSON.stringify(plan)).toContain('wineDefinition_1_key_1_vintage_1_status_1');

    const asked = [{ _id: b20._id, wineDefinition: String(estate._id), vintage: '2020' }];
    const hint = jest.spyOn(mongoose.Query.prototype, 'hint');
    let hinted;
    try {
      hinted = await registryDataOps.publishedValuesForBottles(asked, { types: ['text', 'enum'] });
      expect(hint).toHaveBeenCalledWith(INDEX);
    } finally {
      hint.mockRestore();
    }
    await RegistryDataValue.collection.dropIndex('wineDefinition_1_key_1_vintage_1_status_1');
    try {
      const unhinted = await registryDataOps.publishedValuesForBottles(asked, { types: ['text', 'enum'] });
      expect(unhinted.get(id(b20))).toEqual(hinted.get(id(b20)));
      expect(hinted.get(id(b20)).length).toBeGreaterThan(0);
    } finally {
      await RegistryDataValue.syncIndexes();
    }
  });

  // Last: it erases a member.
  test('an erased member\'s entries stop matching at once: the purge moves the owner\'s version after it deletes', async () => {
    const leaver = await User.create({ username: 'leaver', email: 'leaver@facts.test', password: PASSWORD });
    await Cellar.updateOne({ _id: home._id }, { $push: { members: { user: leaver._id, role: 'editor' } } });
    const a = await personalData.createEntry(leaver._id, b19, { level: 'bottle', newKey: { name: 'Leaver note', type: 'text' }, value: 'Wintergreen' });
    const b = await personalData.createEntry(leaver._id, b20, { level: 'wine', newKey: { name: 'Leaver club', type: 'text' }, value: 'Saltmarsh' });
    expect(a.ok && b.ok).toBe(true);
    const before = versionOf(owner);
    expect(await found('wintergreen', { version: before })).toEqual(ids(b19));
    expect(await found('saltmarsh', { version: before })).toEqual(ESTATE_HERE());

    const { purgeUserData } = require('./userDataRegistry');
    await purgeUserData(leaver._id, 'leaver@facts.test');

    const after = versionOf(owner);
    expect(after).not.toBe(before);
    expect(await found('wintergreen', { version: after })).toEqual([]);
    expect(await found('saltmarsh', { version: after })).toEqual([]);
  }, 60000);
});
