/**
 * Enrichment and the language for the AI-written wine texts
 * (utils/profileLanguage, SuperAdmin → AI).
 *
 * WHY THIS TEST EXISTS:
 * Off — the default — the enrichment must ask and store exactly what it did
 * before the setting existed: no language passed to the model call, and a
 * stored aiProfile with no `localized` key, even when a model answer carries
 * one anyway. On, the same call's translated prose is cleaned by the rules
 * and bounds of the English fields, stored BESIDE the English (never in its
 * place) with its language and the generatedAt of the English it translates;
 * a missing, malformed or partial block stores nothing and never costs the
 * profile itself.
 *
 * Driven through enrichWineById, like enrichmentJob.test.js.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Grape', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([{ name: 'Nebbiolo' }, { name: 'Pinot Noir' }]) }) })),
}));
jest.mock('./labelScan', () => ({ suggestProfile: jest.fn() }));
jest.mock('./aiProvider', () => ({ isConfigured: jest.fn(() => true), effectiveModels: jest.fn(() => null) }));
jest.mock('./embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./appellationResolve', () => ({ appellationHasGeography: jest.fn().mockResolvedValue(false) }));
jest.mock('./aiBudget', () => ({ tryDebitAi: jest.fn(), isRefundableFailure: jest.fn(() => false) }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const aiConfig = require('../config/aiConfig');
const { suggestProfile } = require('./labelScan');
const { enrichWineById } = require('./enrichmentJob');

const WINE_ID = 'a'.repeat(24);
const CONFIG = {
  enrichmentModel: 'claude-sonnet-5',
  enrichmentOnAdd: 'always',
  enrichmentHoldConfidenceFloor: 0.4,
  enrichmentHoldUnknownConfidenceBar: 0.55,
  enrichmentSearchEnabled: true,
  enrichmentSearchDailyCap: 5,
};
const setLanguage = (code) => aiConfig.get.mockReturnValue(code === undefined ? { ...CONFIG } : { ...CONFIG, aiTextLanguage: code });

const chain = (doc) => {
  const c = {};
  for (const m of ['populate', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(doc));
  return c;
};

const ENGLISH = {
  body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry',
  flavors: ['tar', 'rose'], foodPairings: ['braised beef'],
  description: 'Firm and fragrant.', confidence: 0.8,
};
const GERMAN = { description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'] };
const answer = (data) => ({ data: { ...data }, debugReason: null });

// The aiProfile handed to the DB by the (only) write.
const written = () => {
  expect(WineDefinition.updateOne).toHaveBeenCalledTimes(1);
  return WineDefinition.updateOne.mock.calls[0][1].$set.aiProfile;
};

// The keys a published profile has always been written with — hand-listed.
const PUBLISHED_KEYS = [
  'body', 'tannin', 'acidity', 'sweetness', 'flavors', 'foodPairings', 'description',
  'confidence', 'producerSuspect', 'producerUnknown', 'producerNote', 'suspectDowngradedBy',
  'model', 'source', 'generatedAt', 'inputsSnapshot', 'searchUsed', 'heldAt',
];

beforeEach(() => {
  jest.clearAllMocks();
  require('./enrichmentJob')._resetSearchSlots();
  setLanguage(undefined);
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Cannubi Boschis', producer: 'Luciano Sandrone', type: 'red', appellation: 'Barolo',
    country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }],
  }));
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('off: the enrichment asks and stores what it always did', () => {
  test.each([
    ['no key', undefined],
    ['empty', ''],
    ['English', 'en'],
    ['an unknown code', 'xx'],
  ])('%s: no language reaches the call, no copy is stored', async (_, code) => {
    setLanguage(code);
    suggestProfile.mockResolvedValue(answer(ENGLISH));
    expect(await enrichWineById(WINE_ID)).toBe('enriched');
    expect(suggestProfile).toHaveBeenCalledTimes(1);
    expect(suggestProfile.mock.calls[0][0]).not.toHaveProperty('language');
    expect(Object.keys(written())).toEqual(PUBLISHED_KEYS);
  });

  test('a translated block in the answer anyway (a custom prompt) is not stored', async () => {
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, localized: GERMAN }));
    await enrichWineById(WINE_ID);
    expect(written()).not.toHaveProperty('localized');
    expect(written().description).toBe('Firm and fragrant.');
  });
});

describe('on: the translated prose is stored beside the English', () => {
  test('the call asks for the language; the copy carries it and the English generatedAt', async () => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, localized: GERMAN }));
    expect(await enrichWineById(WINE_ID)).toBe('enriched');
    expect(suggestProfile.mock.calls[0][0].language).toBe('de');
    const ap = written();
    expect(ap.localized).toEqual({ lang: 'de', ...GERMAN, generatedAt: ap.generatedAt });
    expect(ap.localized.generatedAt).toBeInstanceOf(Date);
    // The English is exactly what it would be with the setting off.
    expect(ap).toMatchObject({ ...ENGLISH });
    expect(Object.keys(ap)).toEqual([...PUBLISHED_KEYS, 'localized']);
  });

  test('cleaned like the English: markdown stripped, sentinels dropped, the same bounds', async () => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({
      ...ENGLISH,
      localized: {
        description: `**Fest** und duftig. ${'x'.repeat(1200)}`,
        flavors: ['Teer', 'null', 'Rose', 'R'.repeat(80), ...Array.from({ length: 12 }, (_, i) => `F${i}`)],
        foodPairings: ['Schmorbraten', 42, 'N/A'],
      },
    }));
    await enrichWineById(WINE_ID);
    const { localized } = written();
    expect(localized.description.startsWith('Fest und duftig.')).toBe(true);
    expect(localized.description).not.toMatch(/\*/);
    expect(localized.description).toHaveLength(1000);
    expect(localized.flavors).toHaveLength(10);
    expect(localized.flavors.slice(0, 3)).toEqual(['Teer', 'Rose', 'R'.repeat(40)]);
    expect(localized.foodPairings).toEqual(['Schmorbraten']);
  });

  test.each([
    ['no block', undefined],
    ['null', null],
    ['a string', 'Fest und duftig.'],
    ['an array', [GERMAN.description]],
    ['no description', { flavors: GERMAN.flavors, foodPairings: GERMAN.foodPairings }],
    ['a placeholder description', { ...GERMAN, description: 'null' }],
    ['a markup-only description', { ...GERMAN, description: '****' }],
    ['flavours missing where the English has them', { description: GERMAN.description, foodPairings: GERMAN.foodPairings }],
    ['pairings not a list', { ...GERMAN, foodPairings: 'Schmorbraten' }],
    ['only placeholders in a list', { ...GERMAN, flavors: ['null', 'n/a'] }],
  ])('%s: no copy is stored, and the profile publishes as usual', async (_, localized) => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, localized }));
    expect(await enrichWineById(WINE_ID)).toBe('enriched');
    const ap = written();
    expect(ap).not.toHaveProperty('localized');
    expect(ap.description).toBe('Firm and fragrant.');
    expect(ap.flavors).toEqual(['tar', 'rose']);
  });

  test('where the English has no list, the copy has none either', async () => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, foodPairings: [], localized: { ...GERMAN, foodPairings: ['Schmorbraten'] } }));
    await enrichWineById(WINE_ID);
    expect(written().localized.foodPairings).toEqual([]);
  });

  test('a held profile stores no prose, so no copy either', async () => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, producerSuspect: true, producerNote: 'Arcane is a range of Xavier Vignon', localized: GERMAN }));
    expect(await enrichWineById(WINE_ID)).toBe('held');
    const ap = written();
    expect(ap.description).toBeNull();
    expect(ap).not.toHaveProperty('localized');
  });

  test('the search retry asks for the language too, and the copy comes from the answer that is kept', async () => {
    setLanguage('sv');
    suggestProfile
      .mockResolvedValueOnce(answer({ ...ENGLISH, confidence: 0.2, localized: { ...GERMAN, description: 'Första utkastet.' } }))
      .mockResolvedValueOnce(answer({ ...ENGLISH, confidence: 0.8, localized: { ...GERMAN, description: 'Fast och doftande.' } }));
    expect(await enrichWineById(WINE_ID)).toBe('enriched');
    expect(suggestProfile).toHaveBeenCalledTimes(2);
    expect(suggestProfile.mock.calls[1][0]).toMatchObject({ allowSearch: true, language: 'sv' });
    expect(written().localized).toMatchObject({ lang: 'sv', description: 'Fast och doftande.' });
  });

  test('a re-enrichment writes a new English with a new generatedAt, and a copy to match', async () => {
    setLanguage('de');
    suggestProfile.mockResolvedValue(answer({ ...ENGLISH, localized: GERMAN }));
    await enrichWineById(WINE_ID);
    const first = written();
    WineDefinition.updateOne.mockClear();
    await new Promise((r) => setTimeout(r, 5));
    WineDefinition.findById.mockReturnValue(chain({
      _id: WINE_ID, name: 'Cannubi Boschis', producer: 'Luciano Sandrone', type: 'red', appellation: 'Barolo',
      country: { name: 'Italy' }, region: { name: 'Piedmont' }, grapes: [{ name: 'Nebbiolo' }], aiProfile: first,
    }));
    await enrichWineById(WINE_ID, { force: true });
    const second = written();
    expect(second.generatedAt.getTime()).toBeGreaterThan(first.generatedAt.getTime());
    expect(second.localized.generatedAt).toBe(second.generatedAt);
  });
});
