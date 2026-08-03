/**
 * Enrichment persistence — the markdown boundary (#788).
 *
 * aiProfile.description is served RAW by the MCP tools (get_wine, get_bottle),
 * so emphasis the model emits leaks as literal ** to any consumer that doesn't
 * render markdown. The prompt now forbids it, but the prompt is advisory and a
 * self-hoster can override it via SiteConfig — so the strip at the write point
 * is the load-bearing half and is what these tests pin.
 *
 * Driven through enrichWineById (the exported single-wine path); enrichWine
 * itself is module-private and both entry points share it.
 */

jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('./labelScan', () => ({ suggestProfile: jest.fn() }));
jest.mock('./aiProvider', () => ({ isConfigured: jest.fn(() => true) }));
jest.mock('./embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./aiBudget', () => ({ tryDebitAi: jest.fn(), isRefundableFailure: jest.fn(() => false) }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ enrichmentModel: 'claude-sonnet-5' })) }));

const WineDefinition = require('../models/WineDefinition');
const { suggestProfile } = require('./labelScan');
const { enrichWineById } = require('./enrichmentJob');

const WINE_ID = 'a'.repeat(24);

const chain = (doc) => {
  const c = {};
  for (const m of ['populate', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(doc));
  return c;
};

// The profile the model returns; description varies per test.
const profile = (description) => ({
  data: {
    body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry',
    flavors: ['cherry'], foodPairings: ['roast chicken'],
    description, confidence: 0.7,
  },
  debugReason: null,
});

// The aiProfile actually handed to the DB.
const persisted = () => WineDefinition.updateOne.mock.calls[0][1].$set.aiProfile;

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findById.mockReturnValue(chain({
    _id: WINE_ID, name: 'Pinot Noir', producer: 'Matua', type: 'red',
    country: { name: 'New Zealand' }, region: { name: 'Marlborough' }, grapes: [{ name: 'Pinot Noir' }],
  }));
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('aiProfile.description is persisted as plain text', () => {
  // Verbatim from the issue: Matua Pinot Noir, enriched by claude-sonnet-5.
  test('strips the bold emphasis the model emits despite the prompt', async () => {
    suggestProfile.mockResolvedValue(profile(
      'An everyday **cherry**-driven pinot rather than a serious cellaring wine.'
    ));
    await enrichWineById(WINE_ID);
    expect(persisted().description)
      .toBe('An everyday cherry-driven pinot rather than a serious cellaring wine.');
    expect(persisted().description).not.toMatch(/\*/);
  });

  test('leaves already-plain prose byte-identical', async () => {
    const plain = 'Bright red fruit and soft tannins. Drink over the next three years.';
    suggestProfile.mockResolvedValue(profile(plain));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBe(plain);
  });

  test('a description that is pure markup persists as null, not an empty string', async () => {
    // '' would look enriched to the incremental filter and never be retried.
    suggestProfile.mockResolvedValue(profile('****'));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBeNull();
  });

  test('a non-string description still persists as null', async () => {
    suggestProfile.mockResolvedValue(profile(undefined));
    await enrichWineById(WINE_ID);
    expect(persisted().description).toBeNull();
  });

  test('the structured descriptors are untouched by the strip', async () => {
    suggestProfile.mockResolvedValue(profile('Juicy and **bright**.'));
    await enrichWineById(WINE_ID);
    expect(persisted()).toMatchObject({
      body: 'medium', tannin: 'low', acidity: 'medium', sweetness: 'dry',
      flavors: ['cherry'], foodPairings: ['roast chicken'], confidence: 0.7,
    });
  });
});

/**
 * Sentinel-string coercion (support tickets 2026-07-30 / 2026-08-03).
 *
 * The model sometimes emits the four-character STRING "null" inside a
 * string-typed descriptor instead of the JSON literal — 161 prod profiles
 * carried tannin: "null", which passes every truthiness check and leaks the
 * token into the embedding text. The prompt now forbids it, but the write
 * point is the guarantee: sentinel strings and out-of-enum values collapse
 * to a real null.
 */
describe('descriptor sanitization at the write point', () => {
  test('the string "null" persists as a real null (the Fino/Dives case)', async () => {
    const p = profile('A pale, bone-dry fino style.');
    p.data.tannin = 'null';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().tannin).toBeNull();
  });

  test.each([['None'], ['N/A'], ['n/a'], ['undefined'], ['unknown'], [''], ['-']])(
    'sentinel %p collapses to null', async (val) => {
      const p = profile('Fine.');
      p.data.sweetness = val;
      suggestProfile.mockResolvedValue(p);
      await enrichWineById(WINE_ID);
      expect(persisted().sweetness).toBeNull();
    });

  test('an out-of-enum value collapses to null rather than persisting', async () => {
    const p = profile('Fine.');
    p.data.body = 'muscular';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().body).toBeNull();
  });

  test('valid values case-fold onto the enum', async () => {
    const p = profile('Fine.');
    p.data.tannin = 'High';
    p.data.sweetness = ' Off-Dry ';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().tannin).toBe('high');
    expect(persisted().sweetness).toBe('off-dry');
  });

  test('sentinel entries are dropped from flavors/foodPairings, real ones kept', async () => {
    const p = profile('Fine.');
    p.data.flavors = ['cherry', 'null', 'N/A', '  ', 'tar'];
    p.data.foodPairings = ['None', 'roast chicken'];
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().flavors).toEqual(['cherry', 'tar']);
    expect(persisted().foodPairings).toEqual(['roast chicken']);
  });

  test('a producerNote of "null" persists as a real null', async () => {
    const p = profile('Fine.');
    p.data.producerSuspect = true;
    p.data.producerNote = 'null';
    suggestProfile.mockResolvedValue(p);
    await enrichWineById(WINE_ID);
    expect(persisted().producerNote).toBeNull();
    expect(persisted().producerSuspect).toBe(true);
  });
});
