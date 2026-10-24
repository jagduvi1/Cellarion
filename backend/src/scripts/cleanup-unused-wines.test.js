/**
 * scripts/cleanup-unused-wines — what counts as "in use".
 *
 * WHY THIS TEST EXISTS:
 * The script deletes every wine, grape, region and appellation nothing uses.
 * Its lists of what references a wine or a region were written by hand and
 * fell behind the models, so --apply deleted rows that were still referenced.
 * The wine list now comes from utils/wineRefs (whose drift test reads the
 * model files) with the paths read from the schemas; this checks that every
 * schema reference to a wine is either in use or cascaded, never neither or
 * both, that every schema reference to a region or a grape is counted, and
 * the appellation folding. The end-to-end run against a real MongoDB is
 * cleanup-unused-wines.db.test.js.
 */
// The Meilisearch client is ESM-only (Jest cannot load it); the dry runs
// below never reach it.
jest.mock('../services/search', () => ({ initialize: jest.fn(), getIsAvailable: jest.fn(() => true), removeWine: jest.fn() }));

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const {
  cleanup, stillUnreferenced, refPaths, unusedAppellations, WINE_CASCADE_MODELS, WINE_REF_SOURCES, WINE_CASCADE,
  REGION_REF_SOURCES, GRAPE_REF_SOURCES,
} = require('./cleanup-unused-wines');
const { WINE_REF_HANDLED, WINE_REF_EXEMPT } = require('../utils/wineRefs');
const { normalizeAppellationKey } = require('../utils/normalize');
const Appellation = require('../models/Appellation');

// Every model registered, so the drift checks below see every schema.
const modelsDir = path.join(__dirname, '..', 'models');
for (const f of fs.readdirSync(modelsDir)) {
  if (f.endsWith('.js') && !f.endsWith('.test.js')) require(path.join(modelsDir, f));
}

/** "Model.path" for every schema path in any registered model that references `target`. */
const schemaRefs = (target) => mongoose.modelNames()
  .flatMap((name) => refPaths(mongoose.model(name).schema, target).map((p) => `${name}.${p}`))
  .sort();
const pairs = (sources) => sources.map(([Model, p]) => `${Model.modelName}.${p}`).sort();
const cascadePaths = () => WINE_CASCADE.flatMap(([Model, paths]) => paths.map((p) => `${Model.modelName}.${p}`)).sort();

describe('drift: every schema reference is accounted for', () => {
  test('each path that references a wine is either in use or cascaded, never both, never neither', () => {
    const inUse = pairs(WINE_REF_SOURCES);
    const cascaded = cascadePaths();

    expect(inUse.filter((p) => cascaded.includes(p))).toEqual([]);
    // If this fails: a model gained a wine reference. List it in utils/wineRefs
    // (its own test says so too); it then keeps wines in use here unless it is
    // added to WINE_CASCADE_MODELS.
    expect([...inUse, ...cascaded].sort()).toEqual(schemaRefs('WineDefinition'));
  });

  test('references that once let --apply delete a wine still in use keep it', () => {
    expect(pairs(WINE_REF_SOURCES)).toEqual(expect.arrayContaining([
      'PersonalDataEntry.wineDefinition',
      'PriceTrackingSkip.wineDefinition',
      'WineCorrectionProposal.wineDefinition',
      'WineCorrectionProposal.mergeTargetId',
      'WineOwnerInquiry.wineDefinition',
      'WineReport.wineDefinition',
      'WineReport.duplicateOf',
      'WineRequest.linkedWineDefinition',
      // Nested paths, which a top-level distinct() would miss.
      'JournalEntry.pairings.wine',
      'WineList.sections.entries.wine',
      'WineList.autoGroupEntries.wine',
      'RestockAlert.similarWineIds',
    ]));
  });

  test('the cascade names models utils/wineRefs lists, and covers both sides of a not-duplicate pair', () => {
    const listed = [...WINE_REF_HANDLED, ...Object.keys(WINE_REF_EXEMPT)];
    expect(Object.keys(WINE_CASCADE_MODELS).filter((name) => !listed.includes(name))).toEqual([]);
    expect(WINE_CASCADE.map(([Model]) => Model.modelName).sort()).toEqual(Object.keys(WINE_CASCADE_MODELS).sort());
    expect(cascadePaths()).toEqual(expect.arrayContaining(['WineNotDuplicate.wineA', 'WineNotDuplicate.wineB']));
  });

  test('every path that references a region or a grape keeps it in use', () => {
    // If this fails: a model gained a region or grape reference; add it to
    // REGION_REF_SOURCES / GRAPE_REF_SOURCES.
    expect(pairs(REGION_REF_SOURCES)).toEqual(schemaRefs('Region'));
    expect(pairs(GRAPE_REF_SOURCES)).toEqual(schemaRefs('Grape'));
    expect(pairs(REGION_REF_SOURCES)).toEqual(expect.arrayContaining(['Appellation.region', 'Grape.regionalNames.region']));
  });
});

describe('appellation matching', () => {
  const app = (name, synonyms) => ({
    _id: name,
    name,
    normalizedName: normalizeAppellationKey(name),
    ...(synonyms && { normalizedSynonyms: synonyms.map(normalizeAppellationKey) }),
  });
  const docs = [
    app('Barolo'),
    app('Châteauneuf-du-Pape'),
    app('Brunello di Montalcino', ['Brunello']),
    app('Nowhere Valley'),
  ];
  const unusedNames = (wineStrings) => unusedAppellations(docs, wineStrings).map((a) => a.name);

  test('a wine string with a tier suffix keeps its appellation', () => {
    expect(unusedNames(['Barolo DOCG'])).not.toContain('Barolo');
  });

  test('a wine string without accents or hyphens keeps its appellation', () => {
    expect(unusedNames(['Chateauneuf du Pape'])).not.toContain('Châteauneuf-du-Pape');
  });

  test('a wine string that is a synonym keeps its appellation', () => {
    expect(unusedNames(['Brunello'])).not.toContain('Brunello di Montalcino');
  });

  test('an appellation no wine names is unused', () => {
    expect(unusedNames(['Barolo DOCG', 'Chateauneuf du Pape', 'Brunello', null, ''])).toEqual(['Nowhere Valley']);
  });
});

describe('dry run with the reads mocked', () => {
  const id = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
  let distincts;

  beforeEach(() => {
    distincts = {};
    // Model.distinct(path) answers from the table: { ModelName: { path: [ids] } }.
    jest.spyOn(mongoose.Model, 'distinct').mockImplementation(function distinct(p) {
      return Promise.resolve((distincts[this.modelName] || {})[p] || []);
    });
    jest.spyOn(mongoose.Model, 'deleteMany').mockImplementation(() => {
      throw new Error('a dry run must not delete');
    });
    jest.spyOn(Appellation, 'find').mockReturnValue({ lean: () => Promise.resolve([]) });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  test('a region used only by an appellation, or only by a grape\'s regional name, is not unused', async () => {
    const [appRegion, grapeRegion, orphan] = [id(1), id(2), id(3)];
    distincts = {
      Region: { _id: [appRegion, grapeRegion, orphan] },
      Appellation: { region: [appRegion] },
      Grape: { 'regionalNames.region': [grapeRegion] },
    };

    const res = await cleanup();

    expect(res.unusedRegionIds).toEqual([orphan]);
  });

  test('a wine used only by a member\'s personal entry is kept; one with only a vintage profile is deletable', async () => {
    const [personal, profiled, reportedDuplicate] = [id(1), id(2), id(3)];
    distincts = {
      WineDefinition: { _id: [personal, profiled, reportedDuplicate] },
      PersonalDataEntry: { wineDefinition: [personal] },
      WineReport: { duplicateOf: [reportedDuplicate] },
      WineVintageProfile: { wineDefinition: [profiled] },
    };

    const res = await cleanup();

    expect(res.unusedIds).toEqual([profiled]);
  });

  test('a canary is never a candidate: the wine scan leaves canaries out', async () => {
    distincts = { WineDefinition: { _id: [id(1)] } };

    await cleanup();

    const i = mongoose.Model.distinct.mock.contexts.findIndex((Model, n) => Model.modelName === 'WineDefinition'
      && mongoose.Model.distinct.mock.calls[n][0] === '_id');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(mongoose.Model.distinct.mock.calls[i][1]).toEqual({ canary: { $ne: true } });
  });

  test('right before the delete, a candidate that gained a reference since the scan is dropped', async () => {
    const [late, still] = [id(1), id(2)];
    distincts = { Bottle: { wineDefinition: [late] } };

    expect(await stillUnreferenced([late, still])).toEqual([still]);

    // Every source that keeps a wine is asked again, about the candidates only.
    const { calls } = mongoose.Model.distinct.mock;
    expect(calls).toHaveLength(WINE_REF_SOURCES.length);
    for (const [p, filter] of calls) expect(filter).toEqual({ [p]: { $in: [late, still] } });
  });

  test('without options it deletes nothing', async () => {
    distincts = { WineDefinition: { _id: [id(1)] }, Grape: { _id: [id(2)] }, Region: { _id: [id(3)] } };

    const res = await cleanup();

    expect(res.unusedIds).toHaveLength(1);
    expect(mongoose.Model.deleteMany).not.toHaveBeenCalled();
    expect(res.backupFile).toBeNull();
  });
});
