/**
 * scripts/cleanup-unused-wines, run as the operator runs it (the real CLI,
 * a child process) against a real MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * The script deletes registry rows, so "unused" has to mean unused. It kept
 * hand-written lists of what references a wine, a region and an appellation,
 * and those lists fell behind the models: --apply deleted wines that reports,
 * proposals, owner inquiries, price-tracking skips and wine requests still
 * pointed at, regions only an appellation or a grape's regional name used,
 * and appellations wines carry with a tier suffix, without accents or as a
 * synonym. This seeds each kind of reference next to genuinely unused rows,
 * runs the dry run (the default) and --apply, and checks that the dry run
 * deletes nothing and reports what --apply then deletes, which is exactly the
 * unused rows. A canary wine never has a reference and is never deleted, and
 * every row --apply deletes is in its backup file first. The last test runs
 * the cleanup in this process to stage a first bottle arriving between the
 * scan and the delete.
 *
 * Needs a MongoDB: CLEANUP_MONGO_URI, whose database name must start with
 * "cellarion_cleanup" (it is dropped before and after). CI provides one; a
 * local run without it skips the suite with a notice. Locally:
 *   docker network create cleanup-test
 *   docker run -d --rm --name cleanup-mongo --network cleanup-test mongo:7
 *   docker run --rm --network cleanup-test \
 *     -e CLEANUP_MONGO_URI=mongodb://cleanup-mongo:27017/cellarion_cleanup_local \
 *     -v "<repo>/backend:/app" -w /app node:24-alpine \
 *     node node_modules/jest/bin/jest.js src/scripts/cleanup-unused-wines.db.test.js
 *   docker stop cleanup-mongo && docker network rm cleanup-test
 */
// Only the in-process run below loads the script here; the Meilisearch client
// is ESM-only (Jest cannot load it) and that run deletes nothing.
jest.mock('./lib/scriptSearch', () => ({ initSearch: jest.fn(async () => false) }));
jest.mock('../services/search', () => ({ removeWine: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const mongoose = require('mongoose');
const { normalizeAppellationKey } = require('../utils/normalize');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const Bottle = require('../models/Bottle');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const PriceTrackingSkip = require('../models/PriceTrackingSkip');
const WineReport = require('../models/WineReport');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const WineRequest = require('../models/WineRequest');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineNotDuplicate = require('../models/WineNotDuplicate');
const RegistryDataValue = require('../models/RegistryDataValue');
const WineEmbedding = require('../models/WineEmbedding');
const { cleanup } = require('./cleanup-unused-wines');

const URI = process.env.CLEANUP_MONGO_URI;
const SCRIPT = path.join(__dirname, 'cleanup-unused-wines.js');

const describeWithMongo = URI ? describe : describe.skip;
if (!URI) {
  if (process.env.CI) throw new Error('CI must set CLEANUP_MONGO_URI: the cleanup-unused-wines test needs a MongoDB');
  // eslint-disable-next-line no-console
  console.warn('scripts/cleanup-unused-wines.db.test.js skipped: set CLEANUP_MONGO_URI to a cellarion_cleanup* database to run it');
}

const oid = () => new mongoose.Types.ObjectId();
const ids = (rows) => rows.map((r) => String(r._id)).sort();

// Every seeded row, by role. "keep" rows are referenced; "gone" rows are not.
const C = oid();
const R = { parent: oid(), wine: oid(), app: oid(), grape: oid(), canary: oid(), orphan: oid(), doomed: oid(), doomedGrape: oid() };
const G = { wine: oid(), typical: oid(), orphan: oid(), doomed: oid() };
const A = { barolo: oid(), cdp: oid(), brunello: oid(), orphan: oid(), doomed: oid() };
const W = {
  bottle: oid(), personal: oid(), skip: oid(), reportDup: oid(), proposalTarget: oid(), inquiry: oid(), request: oid(),
  canary: oid(), profileOnly: oid(), orphan: oid(),
};
const KEEP = {
  wines: [W.bottle, W.personal, W.skip, W.reportDup, W.proposalTarget, W.inquiry, W.request, W.canary],
  regions: [R.parent, R.wine, R.app, R.grape, R.canary],
  grapes: [G.wine, G.typical],
  appellations: [A.barolo, A.cdp, A.brunello],
};
const GONE = {
  wines: [W.profileOnly, W.orphan],
  // Only the wine about to be deleted, or a grape about to be deleted, uses these.
  regions: [R.orphan, R.doomed, R.doomedGrape],
  grapes: [G.orphan, G.doomed],
  appellations: [A.orphan, A.doomed],
};
const str = (list) => list.map(String).sort();

async function seed() {
  await Country.collection.insertOne({ _id: C, name: 'Testland' });
  await Region.collection.insertMany([
    { _id: R.parent, name: 'Parent Region', country: C },
    { _id: R.wine, name: 'Wine Region', country: C, parentRegion: R.parent, typicalGrapes: [G.typical] },
    { _id: R.app, name: 'Appellation Region', country: C },
    { _id: R.grape, name: 'Grape Name Region', country: C },
    { _id: R.canary, name: 'Canary Region', country: C },
    { _id: R.orphan, name: 'Orphan Region', country: C },
    { _id: R.doomed, name: 'Doomed Region', country: C },
    { _id: R.doomedGrape, name: 'Doomed Grape Region', country: C },
  ]);
  await Grape.collection.insertMany([
    { _id: G.wine, name: 'Wine Grape', normalizedName: 'wine grape', regionalNames: [{ country: C, region: R.grape, name: 'Local Grape' }] },
    { _id: G.typical, name: 'Typical Grape', normalizedName: 'typical grape' },
    { _id: G.orphan, name: 'Orphan Grape', normalizedName: 'orphan grape', regionalNames: [{ country: C, region: R.doomedGrape, name: 'Gone Grape' }] },
    { _id: G.doomed, name: 'Doomed Grape', normalizedName: 'doomed grape' },
  ]);
  const app = (_id, name, extra = {}) => ({ _id, name, normalizedName: normalizeAppellationKey(name), country: C, ...extra });
  await Appellation.collection.insertMany([
    app(A.barolo, 'Barolo', { region: R.app }),
    app(A.cdp, 'Châteauneuf-du-Pape'),
    app(A.brunello, 'Brunello di Montalcino', { synonyms: ['Brunello'], normalizedSynonyms: [normalizeAppellationKey('Brunello')] }),
    app(A.orphan, 'Nowhere Valley'),
    app(A.doomed, 'Doomed Hills'),
  ]);
  const wine = (_id, name, extra = {}) => ({ _id, name, producer: 'Test Producer', country: C, type: 'red', ...extra });
  await WineDefinition.collection.insertMany([
    wine(W.bottle, 'Bottled', { region: R.wine, grapes: [G.wine], appellation: 'Barolo DOCG' }),
    wine(W.personal, 'Personal', { appellation: 'Chateauneuf du Pape' }),
    wine(W.skip, 'Skipped', { appellation: 'Brunello' }),
    wine(W.reportDup, 'Reported Duplicate'),
    wine(W.proposalTarget, 'Merge Target'),
    wine(W.inquiry, 'Inquired'),
    wine(W.request, 'Requested'),
    // A canary has no bottle by design; its region is used by nothing else.
    wine(W.canary, 'Canary', { canary: true, region: R.canary }),
    wine(W.profileOnly, 'Profile Only', { region: R.doomed, grapes: [G.doomed], appellation: 'Doomed Hills' }),
    wine(W.orphan, 'Orphan'),
  ]);

  // The references that keep a wine.
  await Bottle.collection.insertOne({ _id: oid(), wineDefinition: W.bottle });
  await PersonalDataEntry.collection.insertOne({ _id: oid(), targetType: 'wine', wineDefinition: W.personal });
  await PriceTrackingSkip.collection.insertOne({ _id: oid(), wineDefinition: W.skip, vintage: '2015' });
  await WineReport.collection.insertOne({ _id: oid(), wineDefinition: W.bottle, duplicateOf: W.reportDup });
  await WineCorrectionProposal.collection.insertOne({ _id: oid(), wineDefinition: W.bottle, mergeTargetId: W.proposalTarget });
  await WineOwnerInquiry.collection.insertOne({ _id: oid(), wineDefinition: W.inquiry });
  await WineRequest.collection.insertOne({ _id: oid(), linkedWineDefinition: W.request });

  // Rows that only describe a wine: they go with an unused one.
  await WineVintageProfile.collection.insertMany([
    { _id: oid(), wineDefinition: W.profileOnly, vintage: '2018' },
    { _id: oid(), wineDefinition: W.bottle, vintage: '2018' },
    { _id: oid(), wineDefinition: W.canary, vintage: '2016', earlyDrinking: 2021, peakDrinking: 2026, lateDrinking: 2034 },
  ]);
  await WineNotDuplicate.collection.insertOne({ _id: oid(), wineA: W.orphan, wineB: W.bottle });
  await RegistryDataValue.collection.insertOne({ _id: oid(), wineDefinition: W.orphan, key: 'abv', status: 'published' });
  await WineEmbedding.collection.insertOne({ _id: oid(), wineDefinition: W.orphan });
}

async function snapshot() {
  const all = async (Model, filter = {}) => ids(await Model.collection.find(filter).toArray());
  return {
    wines: await all(WineDefinition),
    regions: await all(Region),
    grapes: await all(Grape),
    appellations: await all(Appellation),
    profiles: await all(WineVintageProfile),
    notDuplicates: await all(WineNotDuplicate),
    registryValues: await all(RegistryDataValue),
    embeddings: await all(WineEmbedding),
  };
}

// Asynchronous, so this process keeps its own MongoDB connection alive while
// the script runs. Rejects (with the script's output) on a non-zero exit.
async function runScript(args, tmpDir) {
  const { stdout } = await execFile(process.execPath, [SCRIPT, ...args], {
    timeout: 150000,
    // os.tmpdir() reads TMPDIR: the backup file lands where the test can read it.
    env: { ...process.env, MONGO_URI: URI, MEILI_URL: 'http://127.0.0.1:1', MEILI_MASTER_KEY: 'test', TMPDIR: tmpDir },
  });
  return stdout;
}

const countLine = (out, label) => {
  const m = out.match(new RegExp(`${label} total:\\s+(\\d+)\\s+unused: (\\d+)`));
  return m ? { total: Number(m[1]), unused: Number(m[2]) } : null;
};

describeWithMongo('cleanup-unused-wines against a real MongoDB', () => {
  let tmpDir;
  let before;
  let ours = false;

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_cleanup')) {
      await mongoose.disconnect();
      throw new Error('CLEANUP_MONGO_URI must name a cellarion_cleanup* database: the test drops it');
    }
    ours = true;
    await mongoose.connection.dropDatabase();
    await seed();
    before = await snapshot();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-unused-wines-'));
  }, 60000);

  afterAll(async () => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ours) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }, 60000);

  test('without --apply it is a dry run: nothing is deleted, and it reports exactly the unused rows', async () => {
    const out = await runScript([], tmpDir);

    expect(out).toContain('DRY-RUN');
    expect(await snapshot()).toEqual(before);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(out).toMatch(new RegExp(`Unreferenced wines:\\s+${GONE.wines.length}\\n`));
    expect(countLine(out, 'Grapes')).toEqual({ total: 4, unused: GONE.grapes.length });
    expect(countLine(out, 'Regions')).toEqual({ total: 8, unused: GONE.regions.length });
    expect(countLine(out, 'Appellations')).toEqual({ total: 5, unused: GONE.appellations.length });
  }, 180000);

  test('--apply deletes exactly the unused wines and taxonomy, with the rows that only describe those wines', async () => {
    const doomedProfiles = await WineVintageProfile.collection.find({ wineDefinition: { $in: GONE.wines } }).toArray();
    const out = await runScript(['--apply'], tmpDir);
    const after = await snapshot();

    expect(after.wines).toEqual(str(KEEP.wines));
    expect(after.regions).toEqual(str(KEEP.regions));
    expect(after.grapes).toEqual(str(KEEP.grapes));
    expect(after.appellations).toEqual(str(KEEP.appellations));

    // The unused wines' profile, not-duplicate pair, registry value and
    // embedding went with them; the kept wines' profiles stayed, the canary's
    // curated window among them.
    const keptProfile = await WineVintageProfile.collection.find({ wineDefinition: { $in: [W.bottle, W.canary] } }).toArray();
    expect(keptProfile).toHaveLength(2);
    expect(after.profiles).toEqual(ids(keptProfile));
    expect(after.notDuplicates).toEqual([]);
    expect(after.registryValues).toEqual([]);
    expect(after.embeddings).toEqual([]);

    // Every reference that kept a wine is still there.
    for (const Model of [Bottle, PersonalDataEntry, PriceTrackingSkip, WineReport, WineCorrectionProposal, WineOwnerInquiry, WineRequest]) {
      expect(await Model.collection.countDocuments()).toBe(1);
    }

    // Every deleted row is in the backup, whole: the wines, the rows deleted
    // with them, and the taxonomy.
    const files = fs.readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    expect(out).toContain(path.join(tmpDir, files[0]));
    const rows = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const backedUp = (Model) => rows.filter((r) => r.collection === Model.collection.collectionName).map((r) => r.doc._id).sort();
    expect(backedUp(WineDefinition)).toEqual(str(GONE.wines));
    expect(backedUp(WineVintageProfile)).toEqual(ids(doomedProfiles));
    expect(backedUp(WineNotDuplicate)).toEqual(before.notDuplicates);
    expect(backedUp(RegistryDataValue)).toEqual(before.registryValues);
    expect(backedUp(WineEmbedding)).toEqual(before.embeddings);
    expect(backedUp(Region)).toEqual(str(GONE.regions));
    expect(backedUp(Grape)).toEqual(str(GONE.grapes));
    expect(backedUp(Appellation)).toEqual(str(GONE.appellations));
    expect(rows.find((r) => r.doc._id === String(A.orphan)).doc.name).toBe('Nowhere Valley');
    expect(rows.find((r) => r.doc._id === String(W.orphan)).doc).toMatchObject({ name: 'Orphan', producer: 'Test Producer' });
    expect(rows.find((r) => r.collection === RegistryDataValue.collection.collectionName).doc).toMatchObject({ key: 'abv', status: 'published' });
  }, 180000);

  test('a second --apply finds nothing left to delete', async () => {
    const out = await runScript(['--apply'], tmpDir);

    expect(out).toMatch(/Unreferenced wines:\s+0\n/);
    expect(countLine(out, 'Grapes').unused).toBe(0);
    expect(countLine(out, 'Regions').unused).toBe(0);
    expect(countLine(out, 'Appellations').unused).toBe(0);
  }, 180000);

  test('a wine that gains its first bottle between the scan and the delete is kept, with its profile', async () => {
    const race = oid();
    await WineDefinition.collection.insertOne({ _id: race, name: 'Late Bottle', producer: 'Test Producer', country: C, type: 'red' });
    await WineVintageProfile.collection.insertOne({ _id: oid(), wineDefinition: race, vintage: '2019' });
    // The scan reads the bottles, then the first bottle of the wine is saved.
    const scan = mongoose.Model.distinct;
    jest.spyOn(Bottle, 'distinct').mockImplementationOnce(async function scanThenAdd(...args) {
      const seen = await scan.apply(this, args);
      await Bottle.collection.insertOne({ _id: oid(), wineDefinition: race, status: 'active' });
      return seen;
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});

    let res;
    try {
      res = await cleanup({ apply: true, backupDir: tmpDir });
    } finally {
      jest.restoreAllMocks();
    }

    expect(res.unusedIds.map(String)).not.toContain(String(race));
    expect(await WineDefinition.collection.countDocuments({ _id: race })).toBe(1);
    expect(await WineVintageProfile.collection.countDocuments({ wineDefinition: race })).toBe(1);
  }, 60000);
});
